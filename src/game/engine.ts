/**
 * The deterministic game engine.
 *
 * This file contains no model calls. It parses the player's action, retrieves
 * evidence, asks the scenario for the options that are legal this turn, applies
 * exactly one of them, and then audits the result against the statutory
 * deadlines baked into the mission.
 *
 * The model sits outside this file and can only choose from the options produced
 * here. That is why "a different model cannot corrupt the game state" is a
 * structural property rather than a hope.
 */

import type {
  ActionIntent,
  ActionResolution,
  Effect,
  EffectOption,
  Ending,
  EvidenceBundle,
  GameEvent,
  GameState,
  GameStatus,
  NarrationBlock,
  TurnContext,
  TurnRecord,
} from '../core/types.js';
import { createRng, type Rng } from '../core/rng.js';
import { digestState, stateHash } from '../core/hash.js';
import { applyEffects, checkInvariants, createInitialState, type ScenarioInit } from './state.js';
import { parseAction, validateIntentShape } from './actions/parser.js';
import { resolveAction } from './scenarios/types.js';
import { nairobiFood } from './scenarios/nairobi-food.js';
import { EvidenceAgent } from '../agents/evidence/index.js';
import type { KnowledgeBase } from '../agents/evidence/knowledge.js';
import type { GameMaster } from '../agents/game_master/types.js';
import { CriticAgent } from '../agents/critic/index.js';
import type { CriticVerdict } from '../core/types.js';

export interface GameDeps {
  kb: KnowledgeBase;
  gameMaster: GameMaster;
  critic: CriticAgent;
  evidence: EvidenceAgent;
}

export interface TurnOutcome {
  state: GameState;
  turn: TurnRecord;
  /** Everything Lab Mode needs, and nothing it must not have. */
  lab: LabTurnReport;
}

export interface LabTurnReport {
  turn: number;
  provider: string;
  parsedIntent: { type: string; confidence: number; slots: Record<string, unknown> };
  retrieval: {
    queries: string[];
    returned: Array<{ id: string; grounding: string; score: number; document: string; locator: string; text: string; quote: string }>;
    usable: string[];
    gaps: Array<{ topic: string; reason: string }>;
  };
  optionsConsidered: Array<{ id: string; summary: string; available: boolean; unavailableReason?: string }>;
  chosenOption: { id: string; summary: string } | null;
  rulesFired: string[];
  stateTransition: { before: Record<string, unknown>; after: Record<string, unknown> };
  critic: CriticVerdict | null;
  refusedEffects: Array<{ effect: string; reason: string }>;
}

/* -------------------------------------------------------------------------- */
/* Scenario registry                                                           */
/* -------------------------------------------------------------------------- */

const SCENARIOS = new Map<string, typeof nairobiFood>([[nairobiFood.id, nairobiFood]]);

export function listScenarios(): Array<{ id: string; title: string; subtitle: string; brief: string }> {
  return [...SCENARIOS.values()].map((s) => ({
    id: s.id,
    title: s.title,
    subtitle: s.subtitle,
    brief: s.brief,
  }));
}

export function getScenario(id: string): typeof nairobiFood {
  const scenario = SCENARIOS.get(id);
  if (!scenario) throw new Error(`unknown scenario: ${id}`);
  return scenario;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export function newGame(scenarioId: string, seed: number, kb: KnowledgeBase): GameState {
  // Validate the seed at the boundary rather than at first use. A negative or
  // fractional seed would otherwise be accepted here and blow up deep inside
  // the PRNG on turn one, which is a miserable thing to debug.
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`seed must be an integer between 0 and 4294967295, received ${String(seed)}`);
  }
  const scenario = getScenario(scenarioId);
  const init: ScenarioInit = {
    missionId: scenario.id,
    maxTurns: scenario.maxTurns,
    startingMoney: scenario.startingMoney,
    startDay: scenario.startDay,
    inventory: [],
    flags: {},
    objectives: scenario.objectives,
    endingIds: scenario.endings.map((e) => e.id),
  };
  return createInitialState(init, seed);
}

/* -------------------------------------------------------------------------- */
/* Turn pipeline                                                               */
/* -------------------------------------------------------------------------- */

/** Map a player action to evidence queries worth running. */
export function evidenceQueriesFor(scenario: typeof nairobiFood, intent: ActionIntent): string[] {
  const text = intent.text.toLowerCase();
  const queries = new Set<string>([intent.text]);

  if (/fee|cost|charge|price|ksh|shilling|pay|expensive|cheap|how much/.test(text)) {
    queries.add('prescribed fee registration amount');
    queries.add('how much does business name registration cost');
  }
  if (/name|reserve|search|availability|identical|similar/.test(text)) {
    queries.add('business name search registrar availability');
    queries.add('prohibited business names');
  }
  if (/deadline|days|late|time|urgent|week|month|when/.test(text)) {
    queries.add('how long to register a business name deadline');
    queries.add('twenty-eight days registration requirement');
  }
  if (/certificate|display|hang|show|wall/.test(text)) {
    queries.add('certificate display requirement conspicuous');
  }
  if (/permit|licence|license|county|health|food safety|public health/.test(text)) {
    queries.add('county business permit food licence fee');
  }
  if (/register|registrar|ecitizen|brs|apply|application/.test(text)) {
    queries.add('business name registration requirement Kenya');
    queries.add('business registration service BRS');
  }
  if (intent.type === 'RESEARCH') {
    for (const q of scenario.evidenceSeedQueries) queries.add(q);
  }
  return [...queries].filter((q) => q.trim().length > 0).slice(0, 6);
}

/** Submit a player action and run the full turn. */
export async function submitAction(
  previous: GameState,
  rawInput: string,
  deps: GameDeps,
): Promise<TurnOutcome> {
  const scenario = getScenario(previous.missionId);
  const rng = createRng(previous.seed, previous.rngCursor);
  const intent = parseAction(rawInput);
  const queries = evidenceQueriesFor(scenario, intent);
  const evidence: EvidenceBundle = deps.evidence.retrieveAll(queries);

  // 1. Shape validation happens before anything else. A malformed action is
  //    rejected without costing a turn, which is both fairer and easier to test.
  const shapeError = validateIntentShape(intent);
  if (shapeError) {
    return rejectedTurn(previous, intent, shapeError, deps, evidence, queries);
  }

  // 2. Game over is terminal and also free.
  if (previous.status !== 'ACTIVE') {
    return rejectedTurn(previous, intent, 'This run is already over. Start a new mission to try again.', deps, evidence, queries);
  }
  // 3. The engine computes the legal options for this turn.
  const resolution: ActionResolution = resolveAction(scenario, {
    state: previous,
    intent,
    rng,
    kb: deps.kb,
    evidence,
    evidenceQueries: queries,
  });

  // 4. The model chooses. It cannot author.
  const turnContext: TurnContext = {
    state: previous,
    intent,
    resolution,
    evidence,
    scenarioTitle: scenario.title,
    scenarioBrief: scenario.brief,
    playerProfile: scenario.playerProfile,
  };
  const proposal = await deps.gameMaster.propose(turnContext);

  const available = resolution.options.filter((o) => o.available);
  const chosen: EffectOption | null =
    available.find((o) => o.id === proposal.chosenOptionId) ??
    available[0] ??
    resolution.options[0] ??
    null;

  // 5. Apply. Any effect the engine refuses is reported, not hidden.
  const effects: Effect[] = chosen ? [...chosen.effects] : [];
  const ambient = rollAmbient(scenario, previous, rng, new Set(previous.revealedClaims));
  if (ambient) effects.push(...ambient.effects);

  const applied = applyEffects(previous, effects);

  // 6. Audit the statutory clock, unlock newly-earned objectives, then decide
  //    whether the run is over.
  const audited = auditDeadlines(scenario, applied.state);
  const unlocked = unlockObjectives(audited.state);
  const finalState = resolveEnding(scenario, unlocked);

  // 7. The Critic audits the turn, not the code. It is advisory for the player
  //    but it is the thing the evaluation harness measures.
  const critique = deps.critic.evaluate({
    turn: resolution.turn,
    stateBefore: previous,
    stateAfter: finalState,
    chosenOption: chosen,
    proposal,
    evidence,
    resolution,
    refused: applied.refused,
    // Only the effects that actually landed. Summing the whole list would make
    // the Critic read deliberately-refused spending as state corruption, and it
    // would do so precisely when the player is broke, which is when an
    // accurate report matters most.
    appliedEffects: effects.filter((e) => !applied.refused.some((r) => r.effect === e)),
  });

  const record: TurnRecord = {
    turn: finalState.turn,
    intent,
    optionId: chosen?.id ?? null,
    narration: buildNarration(chosen, proposal.narration, ambient?.narration ?? []),
    events: [...(chosen?.events ?? []), ...(ambient ? [ambient.event] : []), ...audited.events],
    effects,
    evidence: evidence.claims,
    critique,
    stateAfter: digestState(finalState),
    rngCursor: rng.cursor,
    rejection: resolution.rejection,
    provider: deps.gameMaster.name,
    dayAfter: finalState.day,
    moneyAfter: finalState.money,
  };

  finalState.log.push(record);

  const lab: LabTurnReport = {
    turn: record.turn,
    provider: record.provider,
    parsedIntent: {
      type: intent.type,
      confidence: Number(intent.confidence.toFixed(2)),
      slots: redactSlots(intent.slots),
    },
    retrieval: {
      queries,
      returned: evidence.claims.map((c) => ({
        id: c.claim.id,
        grounding: c.claim.grounding,
        score: c.score,
        document: c.claim.documentTitle,
        locator: c.claim.locator,
        text: c.claim.text,
        quote: c.claim.quote,
      })),
      usable: evidence.usable,
      gaps: evidence.gaps.map((g) => ({ topic: g.topic, reason: g.reason })),
    },
    optionsConsidered: resolution.options.map((o) => ({
      id: o.id,
      summary: o.summary,
      available: o.available,
      ...(o.unavailableReason ? { unavailableReason: o.unavailableReason } : {}),
    })),
    chosenOption: chosen ? { id: chosen.id, summary: chosen.summary } : null,
    rulesFired: resolution.rulesFired,
    stateTransition: {
      before: digestState(previous) as unknown as Record<string, unknown>,
      after: digestState(finalState) as unknown as Record<string, unknown>,
    },
    critic: critique,
    refusedEffects: applied.refused.map((r) => ({ effect: r.effect.kind, reason: r.reason })),
  };

  return { state: finalState, turn: record, lab };
}

function buildNarration(
  chosen: EffectOption | null,
  proposed: NarrationBlock[],
  ambient: NarrationBlock[],
): NarrationBlock[] {
  // The engine's narration is authoritative. Model prose is appended only when
  // it does not contradict; the Critic flags it if it does.
  const base = chosen ? chosen.narration : [];
  const extra = proposed.filter(
    (p) => p.grounding === 'FICTIONAL_GAME_EVENT' || p.claimIds.length > 0,
  );
  return [...base, ...extra, ...ambient].filter((b) => b.text.trim().length > 0);
}

function redactSlots(slots: Record<string, string | number | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(slots)) {
    if (k === 'raw') continue;
    out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rejections                                                                  */
/* -------------------------------------------------------------------------- */

function rejectedTurn(
  previous: GameState,
  intent: ActionIntent,
  message: string,
  deps: GameDeps,
  evidence: EvidenceBundle,
  queries: string[],
): TurnOutcome {
  const critique: CriticVerdict = {
    turn: previous.turn,
    passed: true,
    checks: [
      { id: 'rejection', name: 'Action rejected before effects', passed: true, detail: message, severity: 'minor' },
    ],
    unsupportedClaims: [],
    inventedRequirements: [],
    contradictions: [],
    stateTransitionLegal: true,
    groundingRespected: true,
    score: 100,
    summary: 'Action rejected. No state change.',
  };

  const record: TurnRecord = {
    turn: previous.turn,
    intent,
    optionId: null,
    narration: [
      { text: `[Turn ${previous.turn + 1}] ${message}`, grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] },
    ],
    events: [],
    effects: [],
    evidence: evidence.claims,
    critique,
    stateAfter: digestState(previous),
    rngCursor: previous.rngCursor,
    rejection: {
      code: 'AMBIGUOUS_ACTION',
      message,
      clarification: 'Rephrase, or use one of the action buttons.',
      costsTurn: false,
    },
    provider: deps.gameMaster.name,
    dayAfter: previous.day,
    moneyAfter: previous.money,
  };

  return {
    state: previous,
    turn: record,
    lab: {
      turn: previous.turn,
      provider: deps.gameMaster.name,
      parsedIntent: { type: intent.type, confidence: Number(intent.confidence.toFixed(2)), slots: redactSlots(intent.slots) },
      retrieval: { queries, returned: [], usable: evidence.usable, gaps: evidence.gaps.map((g) => ({ topic: g.topic, reason: g.reason })) },
      optionsConsidered: [],
      chosenOption: null,
      rulesFired: [],
      stateTransition: { before: digestState(previous) as unknown as Record<string, unknown>, after: digestState(previous) as unknown as Record<string, unknown> },
      critic: critique,
      refusedEffects: [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ambient events                                                              */
/* -------------------------------------------------------------------------- */

function rollAmbient(
  scenario: typeof nairobiFood,
  state: GameState,
  rng: Rng,
  revealed: Set<string>,
): { event: GameEvent; effects: Effect[]; narration: NarrationBlock[] } | null {
  // Ambient events only complicate an already-active run.
  if (state.turn === 0) return null;
  if (rng.next() > 0.3) return null;

  // Do not repeat what just happened. A repeated event reads as a bug and
  // teaches the player nothing.
  const lastEventId = state.log[state.log.length - 1]?.events[0]?.id;

  const pool = scenario.ambient.filter(
    (e) => (e.when ? e.when({ state, revealed }) : true) && e.id !== lastEventId,
  );
  if (pool.length === 0) return null;

  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng.next() * total;
  let chosen = pool[0]!;
  for (const candidate of pool) {
    roll -= candidate.weight;
    if (roll <= 0) {
      chosen = candidate;
      break;
    }
  }

  return {
    event: {
      id: chosen.id,
      title: chosen.title,
      body: chosen.body,
      kind: chosen.kind,
      grounding: 'FICTIONAL_GAME_EVENT',
      claimIds: [],
      severity: chosen.severity,
    },
    effects: chosen.effects(rng),
    narration: chosen.narration ? chosen.narration(rng) : [],
  };
}

/* -------------------------------------------------------------------------- */
/* Statutory audit                                                             */
/* -------------------------------------------------------------------------- */

function auditDeadlines(scenario: typeof nairobiFood, state: GameState): { state: GameState; events: GameEvent[] } {
  if (state.status !== 'ACTIVE') return { state, events: [] };
  const events: GameEvent[] = [];
  const next = state;
  const tradingDay = Number(next.flags['tradingDay'] ?? 0);
  const registered = next.flags['registered'] === 'yes';
  const searchDay = Number(next.flags['nameSearchDay'] ?? 0);
  const decisionDay = Number(next.flags['nameDecisionDay'] ?? 0);

  // Section 8(1): registration is due within twenty-eight days of commencing
  // business. This is real, quotable law, so the consequence is real in-game.
  if (tradingDay > 0 && !registered && next.day - tradingDay > 28) {
    if (next.flags['registrationOverdue'] !== 'yes') {
      next.flags['registrationOverdue'] = 'yes';
      const obj = next.objectives.find((o) => o.id === 'o-register');
      if (obj && obj.status !== 'COMPLETE') obj.status = 'FAILED';
      events.push({
        id: 'overdue-28',
        title: 'Twenty-eight days gone',
        body: 'You commenced business and you are not registered. Section 8(1) makes the statement of particulars due within twenty-eight days of that moment, and section 10 makes default an offence.',
        kind: 'OBSTACLE',
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-03', 'C-RBN-12', 'C-RBN-13'],
        severity: 'danger',
      });
    }
  }

  // Section 17(2): the name search must precede trading by at least seven days.
  if (tradingDay > 0 && searchDay === 0) {
    if (next.flags['searchWarning'] !== 'yes') {
      next.flags['searchWarning'] = 'yes';
      events.push({
        id: 'search-warning',
        title: 'Trading with no search on file',
        body: 'Section 17(2) expects the request to have gone out not less than seven days before you commenced. You never sent it.',
        kind: 'OBSTACLE',
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-06'],
        severity: 'danger',
      });
    }
  }

  // Section 17(3): the twenty-eight day reservation window.
  if (decisionDay > 0 && next.flags['nameDecision'] === 'granted' && !registered && next.day - decisionDay > 28) {
    if (next.flags['reservationLapsed'] !== 'yes') {
      next.flags['reservationLapsed'] = 'yes';
      events.push({
        id: 'reservation-lapsed',
        title: 'The name went back into the pool',
        body: 'Twenty-eight days from the decision, the name is no longer held for you. Section 17(3).',
        kind: 'OBSTACLE',
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-07'],
        severity: 'danger',
      });
    }
  }

  // The certificate must be displayed, not merely received.
  if (registered && !next.inventory.some((i) => i.id === 'certificate' && i.quantity > 0) && next.flags['displayed'] !== 'yes') {
    // A registered business that has not been issued its certificate is an
    // inconsistent state the scenario should never produce; the audit reports it.
    events.push({
      id: 'no-certificate',
      title: 'Registered but no certificate',
      body: 'The state says you are registered but you hold no certificate. This should be impossible; the audit is flagging it.',
      kind: 'SYSTEM',
      grounding: 'UNKNOWN',
      claimIds: [],
      severity: 'warn',
    });
  }

  if (next.money <= 0) {
    // The ending resolver handles insolvency. Here we only make sure the flag
    // is visible in Lab Mode.
    events.push({
      id: 'broke',
      title: 'The account is empty',
      body: 'You have nothing left to spend. Trading without capital ends the run.',
      kind: 'OBSTACLE',
      grounding: 'FICTIONAL_GAME_EVENT',
      claimIds: [],
      severity: 'danger',
    });
  }

  return { state: next, events };
}

/* -------------------------------------------------------------------------- */
/* Objective unlocking                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Unlock objectives whose evidence requirement the player has now met.
 *
 * Engine-owned on purpose. The Game Master decides what happens; the engine
 * decides what the player is now allowed to attempt. An objective that demands
 * a claim the player has read should not sit in LOCKED because no rule happened
 * to emit an unlock effect.
 */
function unlockObjectives(state: GameState): GameState {
  if (state.status !== 'ACTIVE') return state;
  const revealed = new Set(state.revealedClaims);
  let changed = false;
  for (const obj of state.objectives) {
    if (obj.status !== 'LOCKED') continue;
    if (obj.requiresClaims.length > 0 && obj.requiresClaims.every((id) => revealed.has(id))) {
      obj.status = 'ACTIVE';
      changed = true;
    }
  }
  return changed ? state : state;
}

/* -------------------------------------------------------------------------- */
/* Ending                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Should the run stop right now?
 *
 * Only two things end a run early: running out of money, and running out of
 * turns. Completing an objective does not.
 *
 * This is the correction for the most obvious way to get this design wrong.
 * An earlier version ended the run the moment the player served a customer,
 * which meant you could "win" Bureaucracy Boss Fight without ever registering
 * anything - you would be graded on plating food while the whole point of the
 * game went unwatched. A mission with a fourteen-turn budget should spend it.
 * The ending is therefore a grade applied at the end, not a trigger fired
 * midway.
 */
function shouldEndRun(state: GameState): GameStatus | null {
  if (state.money <= 0) return 'LOST';
  if (state.turn >= state.maxTurns) return 'TIMEOUT';
  return null;
}

/**
 * Grade a finished run. Reads the final state and picks the best-supported
 * ending. `status` is what the run ended as.
 */
export function computeEnding(
  scenario: typeof nairobiFood,
  state: GameState,
  status: GameStatus,
): Ending {
  const byId = new Map(scenario.endings.map((e) => [e.id, e]));
  const complete = (id: string): boolean => state.objectives.some((o) => o.id === id && o.status === 'COMPLETE');
  const failed = (id: string): boolean => state.objectives.some((o) => o.id === id && o.status === 'FAILED');

  const pick = (id: string): Ending =>
    byId.get(id) ?? { id, title: 'Unfinished', grade: 'C', blurb: 'The run ended without a clear resolution.' };

  if (state.money <= 0) return pick('e-broke');
  if (status === 'LOST') return pick('e-unregistered');

  const registered = state.flags['registered'] === 'yes';
  const ownName = state.flags['ownNameRoute'] === 'yes';
  const overdue = state.flags['registrationOverdue'] === 'yes' || failed('o-register');
  const solvent = state.money > 0;

  if (ownName && complete('o-trade')) return pick('e-own-name');
  if (overdue && complete('o-trade')) return pick('e-unregistered');
  if (
    complete('o-survey') &&
    complete('o-fee') &&
    complete('o-name') &&
    registered &&
    complete('o-display') &&
    complete('o-trade') &&
    solvent
  ) {
    return pick('e-certified');
  }
  if (registered && complete('o-trade') && solvent) return pick('e-registered');
  if (complete('o-trade')) return pick('e-trading');
  if (status === 'TIMEOUT') return pick('e-timeout');
  if (overdue) return pick('e-unregistered');
  return pick('e-timeout');
}

function resolveEnding(scenario: typeof nairobiFood, state: GameState): GameState {
  if (state.status !== 'ACTIVE') return state;

  const status = shouldEndRun(state);
  if (status === null) return state;

  const ending = computeEnding(scenario, state, status);
  const applied = applyEffects(
    state,
    [
      { kind: 'STATUS_SET', status, ruleId: 'engine-ending', reason: `Ending: ${ending.id}` },
      { kind: 'ENDING_SET', ending, ruleId: 'engine-ending', reason: `Run resolved on turn ${state.turn}.` },
    ],
    { advanceTurn: false },
  );
  return applied.state;
}

/* -------------------------------------------------------------------------- */
/* Replay                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReplayInput {
  scenarioId: string;
  seed: number;
  actions: string[];
}

/**
 * Replay a run from scratch. Given the same seed and the same action sequence
 * the resulting state hash must be identical. This is evaluation test #8 and it
 * is the guarantee that makes the AI's contribution auditable.
 */
export function replay(
  input: ReplayInput,
  deps: GameDeps,
): Promise<{ state: GameState; hash: string; trace: string[] }> {
  return (async () => {
    let state = newGame(input.scenarioId, input.seed, deps.kb);
    const trace: string[] = [];
    for (const action of input.actions) {
      const outcome = await submitAction(state, action, deps);
      state = outcome.state;
      trace.push(`${outcome.turn.turn}:${outcome.turn.optionId ?? 'rejected'}:${stateHash(state)}`);
      if (state.status !== 'ACTIVE') break;
    }
    return { state, hash: stateHash(state), trace };
  })();
}

/** Validate a state, for use by the API and the tests. */
export function validate(state: GameState) {
  return { ok: checkInvariants(state).length === 0, violations: checkInvariants(state) };
}

export { digestState, stateHash };
