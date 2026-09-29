/**
 * Scenario framework.
 *
 * A scenario owns the rules. Rules are pure functions from
 * `(state, intent, rng)` to a set of engine-produced `EffectOption`s.
 *
 * This is the whole anti-hallucination trick in one sentence: **a language model
 * picks an option; it cannot write one.** Options are produced by code, carry a
 * `ruleId`, and every effect inside them names the rule that produced it. If a
 * model invents a rule id, a fee, or a deadline, there is nowhere for it to put
 * it. See `docs/architecture.md`.
 */

import type {
  ActionIntent,
  ActionResolution,
  Effect,
  EffectOption,
  EvidenceBundle,
  Ending,
  GameEvent,
  GameState,
  NarrationBlock,
  ObjectiveState,
} from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import type { KnowledgeBase } from '../../agents/evidence/knowledge.js';

export interface RuleContext {
  state: GameState;
  intent: ActionIntent;
  rng: Rng;
  kb: KnowledgeBase;
  /** Full evidence bundle for this turn: retrieved claims, usable ids, gaps. */
  evidence: EvidenceBundle;
  /** Claim ids the evidence agent surfaced for this turn. */
  retrieved: string[];
  /** Claim ids the player has already learned this run. */
  revealed(): Set<string>;
  /** Build a narration block that cites knowledge-base claims. */
  cite(text: string, claimIds: string[], grounding?: NarrationBlock['grounding']): NarrationBlock;
  /** Narration about the fiction. Never a real-world claim. */
  fiction(text: string): NarrationBlock;
}

export interface Rule {
  id: string;
  /** Human-readable purpose, shown in Lab Mode. Not chain-of-thought. */
  purpose: string;
  when(ctx: RuleContext): boolean;
  resolve(ctx: RuleContext): EffectOption[];
}

export interface AmbientEvent {
  id: string;
  title: string;
  body: string;
  kind: GameEvent['kind'];
  severity: GameEvent['severity'];
  /** Probability weight for selection. */
  weight: number;
  /** `when` may veto the event entirely. */
  when?(ctx: { state: GameState; revealed: Set<string> }): boolean;
  effects(rng: Rng): Effect[];
  /** Additional narration when the event fires. */
  narration?(rng: Rng): NarrationBlock[];
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  subtitle: string;
  brief: string;
  playerProfile: string;
  maxTurns: number;
  startingMoney: number;
  startDay: number;
  /** In-world calendar label for day 1. Purely fictional framing. */
  calendarEpoch: string;
  objectives: ObjectiveState[];
  endings: Ending[];
  rules: Rule[];
  ambient: AmbientEvent[];
  /** Opening narration, fixed. */
  opening(): NarrationBlock[];
  /** Suggested evidence queries, used by Lab Mode's "what did the GM look up". */
  evidenceSeedQueries: string[];
}

/* -------------------------------------------------------------------------- */
/* Option builders                                                             */
/* -------------------------------------------------------------------------- */

export function option(
  id: string,
  summary: string,
  effects: Effect[],
  narration: NarrationBlock[],
  extra: Partial<EffectOption> = {},
): EffectOption {
  return {
    id,
    summary,
    effects,
    narration,
    events: extra.events ?? [],
    available: extra.available ?? true,
    ...(extra.unavailableReason ? { unavailableReason: extra.unavailableReason } : {}),
  };
}

/**
 * Mark an option unavailable if the player cannot afford its net cost.
 * The engine never offers a purchase the player cannot pay for, and
 * `applyEffects` refuses it a second time. Two independent guards, because
 * "money cannot become negative" is a test and a test should not be able to
 * pass by accident.
 */
export function gateOnFunds(opt: EffectOption, state: GameState): EffectOption {
  const net = opt.effects
    .filter((e): e is Extract<Effect, { kind: 'MONEY_DELTA' }> => e.kind === 'MONEY_DELTA')
    .reduce((sum, e) => sum + e.delta, 0);
  if (state.money + net >= 0) return opt;
  return {
    ...opt,
    available: false,
    unavailableReason: `This needs KSh ${Math.abs(net).toLocaleString('en-KE')} and you have KSh ${state.money.toLocaleString('en-KE')}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Engine glue                                                                 */
/* -------------------------------------------------------------------------- */

export interface ResolutionInput {
  state: GameState;
  intent: ActionIntent;
  rng: Rng;
  kb: KnowledgeBase;
  evidence: EvidenceBundle;
  evidenceQueries: string[];
}

export function resolveAction(scenario: ScenarioDefinition, input: ResolutionInput): ActionResolution {
  const revealed = new Set(input.state.revealedClaims);

  const ctx: RuleContext = {
    state: input.state,
    intent: input.intent,
    rng: input.rng,
    kb: input.kb,
    evidence: input.evidence,
    retrieved: input.evidence.usable,
    revealed: () => revealed,
    cite: (text, claimIds, grounding) => ({
      text,
      grounding: grounding ?? (claimIds.length > 0 ? 'VERIFIED' : 'UNKNOWN'),
      claimIds,
    }),
    fiction: (text) => ({ text, grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] }),
  };

  for (const rule of scenario.rules) {
    if (!rule.when(ctx)) continue;
    const options = rule.resolve(ctx).map((opt) => gateOnFunds(opt, input.state));
    return {
      turn: input.state.turn + 1,
      intent: input.intent,
      options: options.length > 0 ? options : [noopOption('nothing-happens', input.state)],
      rejection: null,
      preamble: [],
      rulesFired: [rule.id],
      evidenceQueries: input.evidenceQueries,
    };
  }

  return {
    turn: input.state.turn + 1,
    intent: input.intent,
    options: [noopOption('nothing-happens', input.state)],
    rejection: {
      code: 'UNKNOWN_ACTION',
      message: 'Nothing you said maps to anything the scenario recognises.',
      clarification:
        'Try one of the action buttons, or say something concrete like "research the registration fee" or "buy a trolley for KSh 5,000".',
      costsTurn: false,
    },
    preamble: [],
    rulesFired: [],
    evidenceQueries: input.evidenceQueries,
  };
}

function noopOption(id: string, state: GameState): EffectOption {
  return option(
    id,
    'No change to the simulation.',
    [],
    [
      {
        text: `[Turn ${state.turn + 1} passes with nothing accomplished. In a real month, an unproductive fortnight still burns rent.]`,
        grounding: 'FICTIONAL_GAME_EVENT',
        claimIds: [],
      },
    ],
  );
}
