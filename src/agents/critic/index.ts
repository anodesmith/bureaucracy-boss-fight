/**
 * CRITIC / JUDGE
 * ==============
 * Evaluates the turn that just happened, and emits structured evaluation data.
 *
 * Every check here is deterministic code, not a model call. That is a
 * deliberate choice and it is the reason this agent is worth having:
 *
 *   - The Critic must be able to fail. A judge that is itself a language model
 *     cannot be used to measure whether a language model hallucinated, because
 *     its failure mode is identical to the thing it is measuring.
 *   - A model critic would be non-deterministic, which would make evaluation
 *     scores noisy and replay impossible.
 *   - Every check must be re-runnable and comparable across providers. That
 *     requires code.
 *
 * The Critic is adversarial by construction. Its default expectation is that a
 * claim is unsupported until the citation proves otherwise, and it is wired to
 * look specifically for the four failure modes this project exists to prevent:
 * invented requirements, laundered unknowns, contradictions, and state damage.
 */

import type {
  ActionResolution,
  Contradiction,
  CriticCheck,
  CriticVerdict,
  EffectOption,
  Effect,
  EvidenceBundle,
  GameMasterProposal,
  GameState,
  NarrationBlock,
  TurnRecord,
} from '../../core/types.js';
import { EvidenceAgent, looksLikeInventedRequirement, looksLikeRealWorldClaim } from '../evidence/index.js';
import { checkInvariants } from '../../game/state.js';
import { digestState } from '../../core/hash.js';

export interface CriticInput {
  turn: number;
  stateBefore: GameState;
  stateAfter: GameState;
  chosenOption: EffectOption | null;
  proposal: GameMasterProposal;
  evidence: EvidenceBundle;
  resolution: ActionResolution;
  refused: Array<{ effect: unknown; reason: string }>;
  /**
   * Every effect the engine actually applied this turn, including ambient
   * events. The Critic reconciles money against this rather than against
   * `chosenOption.effects`, because an option's effects alone do not account
   * for everything that landed - ambient events move money too, and missing
   * them would make the Critic report a false state-corruption failure.
   */
  appliedEffects: Effect[];
}

export interface CriticOptions {
  /** Score below which a turn is marked failed. */
  passThreshold?: number;
  /**
   * When true, the Critic audits the full narration the player actually saw,
   * including engine text. Off by default: the Critic's job is to audit the
   * AGENTS, and the engine's own prose is covered by the invariant tests.
   */
  auditEngineNarration?: boolean;
}

export class CriticAgent {
  private readonly evidence: EvidenceAgent;
  private readonly passThreshold: number;
  private readonly auditEngineNarration: boolean;

  constructor(evidence: EvidenceAgent, options: CriticOptions = {}) {
    this.evidence = evidence;
    this.passThreshold = options.passThreshold ?? 70;
    this.auditEngineNarration = options.auditEngineNarration ?? false;
  }

  evaluate(input: CriticInput): CriticVerdict {
    const checks: CriticCheck[] = [];
    const unsupportedClaims: string[] = [];
    const inventedRequirements: string[] = [];
    const contradictions: Contradiction[] = [];

    const auditBlocks: NarrationBlock[] = [
      ...input.proposal.narration,
      ...(this.auditEngineNarration ? (input.chosenOption?.narration ?? []) : []),
    ];

    /* --- 1. Citation integrity ----------------------------------------- */
    for (const block of auditBlocks) {
      const assertsFact =
        block.grounding === 'VERIFIED' || block.grounding === 'INFERRED';

      for (const id of block.claimIds) {
        if (!this.evidence.hasClaim(id)) {
          // An invented claim id is always a blocking failure, whatever the
          // label on the block.
          unsupportedClaims.push(id);
          checks.push({
            id: `citation-missing-${id}`,
            name: `Citation ${id} exists`,
            passed: false,
            detail: `The Game Master cited ${id}, which does not exist in the knowledge base.`,
            severity: 'blocking',
          });
          continue;
        }

        if (!assertsFact) {
          // A block labelled UNKNOWN or FICTIONAL is not asserting its
          // citations, it is *reporting* them. Citing an UNKNOWN claim inside
          // an UNKNOWN block is exactly right - it is how the player learns
          // that the record has a hole. Only existence is required.
          continue;
        }

        const check = this.evidence.validateCitation(id, block.text);
        if (!check.ok) {
          unsupportedClaims.push(id);
          checks.push({
            id: `citation-${id}`,
            name: `Citation ${id} supports the claim`,
            passed: false,
            detail: check.reason,
            severity: 'blocking',
          });
        }
      }

      const verdict = this.evidence.classifyNarration(block.text, block.claimIds);

      if (assertsFact && verdict.grounding !== block.grounding) {
        // A block that claims VERIFIED but whose citations do not support it.
        checks.push({
          id: `ungrounded-${checks.length}`,
          name: 'Real-world assertion is grounded',
          passed: false,
          detail: `"${truncate(block.text, 120)}" is labelled ${block.grounding} but the evidence does not support it. ${verdict.reason}`,
          severity: 'blocking',
        });
      }

      if (block.grounding === 'VERIFIED' && block.claimIds.length === 0) {
        checks.push({
          id: `bare-verified-${checks.length}`,
          name: 'VERIFIED blocks carry citations',
          passed: false,
          detail: `"${truncate(block.text, 120)}" is labelled VERIFIED with no claim ids.`,
          severity: 'blocking',
        });
      }

      // An UNKNOWN block that nonetheless tells the player a specific
      // institutional rule is giving an answer while claiming ignorance.
      // This is a real failure mode and worth catching, but it is not the
      // same failure as fabrication, so it is scored as major.
      if (block.grounding === 'UNKNOWN' && looksLikeInventedRequirement(block.text)) {
        checks.push({
          id: `assertive-unknown-${checks.length}`,
          name: 'UNKNOWN blocks do not quietly give an answer',
          passed: false,
          detail: `"${truncate(block.text, 140)}" is labelled UNKNOWN but states a specific institutional requirement or charge.`,
          severity: 'major',
        });
      }

      if (block.grounding === 'FICTIONAL_GAME_EVENT' && looksLikeInventedRequirement(block.text)) {
        inventedRequirements.push(truncate(block.text, 140));
        checks.push({
          id: `fiction-as-fact-${checks.length}`,
          name: 'Simulation events do not masquerade as real-world claims',
          passed: false,
          detail: `"${truncate(block.text, 140)}" is marked FICTIONAL_GAME_EVENT but tells the player a real institution requires or charges something specific.`,
          severity: 'major',
        });
      }
    }

    if (checks.length === 0) {
      checks.push({
        id: 'citation-integrity',
        name: 'Every citation resolves to a usable claim',
        passed: true,
        detail: 'All agent narration was either fictional scene-setting or correctly cited.',
        severity: 'minor',
      });
    }

    /* --- 2. Unknown laundering ----------------------------------------- */
    for (const block of auditBlocks) {
      for (const id of block.claimIds) {
        const claim = this.evidence.getClaim(id);
        if (claim?.grounding === 'UNKNOWN' && block.grounding !== 'UNKNOWN') {
          unsupportedClaims.push(id);
          checks.push({
            id: `launder-${id}`,
            name: `Unknown ${id} is not presented as known`,
            passed: false,
            detail: `Claim ${id} is UNKNOWN but was used to support a ${block.grounding} statement.`,
            severity: 'blocking',
          });
        }
      }
    }

    /* --- 3. Contradiction detection ------------------------------------ */
    for (const block of auditBlocks) {
      for (const id of block.claimIds) {
        const contradiction = this.findContradiction(block.text, id);
        if (contradiction) contradictions.push(contradiction);
      }
    }
    if (contradictions.length > 0) {
      checks.push({
        id: 'contradictions',
        name: 'Narration does not contradict the knowledge base',
        passed: false,
        detail: `${contradictions.length} contradiction(s): ${contradictions.map((c) => truncate(c.assertion, 60)).join(' | ')}`,
        severity: 'blocking',
      });
    } else {
      checks.push({
        id: 'contradictions',
        name: 'Narration does not contradict the knowledge base',
        passed: true,
        detail: 'No cited claim was contradicted.',
        severity: 'minor',
      });
    }

    /* --- 4. State transition legality ---------------------------------- */
    const before = digestState(input.stateBefore);
    const after = digestState(input.stateAfter);
    const stateTransitionLegal = this.checkTransition(input, before, after);
    checks.push(
      stateTransitionLegal.passed
        ? { id: 'state-transition', name: 'State transition is legal', passed: true, detail: stateTransitionLegal.detail, severity: 'blocking' }
        : { id: 'state-transition', name: 'State transition is legal', passed: false, detail: stateTransitionLegal.detail, severity: 'blocking' },
    );

    /* --- 5. Option selection honesty ----------------------------------- */
    const optionCheck = this.checkOptionSelection(input);
    checks.push(optionCheck);

    /* --- 6. Invariants ------------------------------------------------- */
    const violations = checkInvariants(input.stateAfter).filter((v) => v.severity === 'blocking');
    checks.push(
      violations.length === 0
        ? { id: 'invariants', name: 'All state invariants hold', passed: true, detail: 'money, turn, inventory and claim ids are all valid.', severity: 'blocking' }
        : { id: 'invariants', name: 'All state invariants hold', passed: false, detail: violations.map((v) => `${v.invariant}: ${v.detail}`).join('; '), severity: 'blocking' },
    );

    /* --- 7. Refused effects are surfaced ------------------------------- */
    if (input.refused.length > 0) {
      checks.push({
        id: 'refused-effects',
        name: 'Refused effects were surfaced rather than dropped',
        passed: true,
        detail: `${input.refused.length} effect(s) refused by the engine: ${input.refused.map((r) => r.reason).join('; ')}`,
        severity: 'minor',
      });
    }

    /* --- Score --------------------------------------------------------- */
    const blocking = checks.filter((c) => c.severity === 'blocking');
    const blockingFailed = blocking.filter((c) => !c.passed).length;
    const majorFailed = checks.filter((c) => c.severity === 'major' && !c.passed).length;
    const total = checks.length;
    const passedCount = checks.filter((c) => c.passed).length;
    const raw = total === 0 ? 100 : Math.round((passedCount / total) * 100) - blockingFailed * 25 - majorFailed * 10;

    // Score and verdict must agree. A ratio of passed checks is a bad summary
    // when one of the failures is a grounding violation: nine clean checks
    // should not average away the fact that the Game Master invented a
    // requirement. Any failure caps the score below the pass threshold, so a
    // failed turn can never display a number that reads like a pass.
    const cap = blockingFailed > 0 ? 49 : majorFailed > 0 ? 69 : 100;
    const clamped = Math.max(0, Math.min(100, Math.min(raw, cap)));

    // A grounding violation is not excusable by averaging. A turn can pass nine
    // checks and still have told the player an invented requirement; a score
    // threshold alone let a single major failure slip through on a long,
    // mostly-clean turn. Grounding failures are absolute.
    const passed = clamped >= this.passThreshold && blockingFailed === 0 && majorFailed === 0;

    return {
      turn: input.turn,
      passed,
      checks,
      unsupportedClaims: [...new Set(unsupportedClaims)],
      inventedRequirements: [...new Set(inventedRequirements)],
      contradictions,
      stateTransitionLegal: stateTransitionLegal.passed,
      groundingRespected: !checks.some(
        (c) =>
          c.id.startsWith('ungrounded-') ||
          c.id.startsWith('fiction-as-fact-') ||
          c.id.startsWith('assertive-unknown-') ||
          c.id.startsWith('launder-'),
      ),
      score: clamped,
      summary: this.summarise(passed, clamped, blockingFailed, majorFailed, unsupportedClaims.length, inventedRequirements.length, contradictions.length),
    };
  }

  /** Audit a finished run rather than a single turn. */
  auditRun(records: TurnRecord[]): {
    turns: number;
    passed: number;
    meanScore: number;
    totalUnsupportedClaims: number;
    totalInventedRequirements: number;
    totalContradictions: number;
    groundingsUsed: Record<string, number>;
  } {
    const groundings: Record<string, number> = {};
    let scoreSum = 0;
    let passed = 0;
    let unsupported = 0;
    let invented = 0;
    let contradictions = 0;

    for (const record of records) {
      for (const block of record.narration) {
        groundings[block.grounding] = (groundings[block.grounding] ?? 0) + 1;
      }
      if (!record.critique) continue;
      scoreSum += record.critique.score;
      if (record.critique.passed) passed += 1;
      unsupported += record.critique.unsupportedClaims.length;
      invented += record.critique.inventedRequirements.length;
      contradictions += record.critique.contradictions.length;
    }

    return {
      turns: records.length,
      passed,
      meanScore: records.length === 0 ? 0 : Number((scoreSum / records.length).toFixed(1)),
      totalUnsupportedClaims: unsupported,
      totalInventedRequirements: invented,
      totalContradictions: contradictions,
      groundingsUsed: groundings,
    };
  }

  /* -------------------------------------------------------------------- */

  private checkTransition(
    input: CriticInput,
    before: ReturnType<typeof digestState>,
    after: ReturnType<typeof digestState>,
  ): { passed: boolean; detail: string } {
    if (input.stateAfter === input.stateBefore) {
      return { passed: true, detail: 'No state change (rejected action or a no-op turn).' };
    }

    const turnDelta = after.turn - before.turn;
    if (turnDelta > 1) {
      return { passed: false, detail: `turn advanced by ${turnDelta}; the engine must advance by exactly 1` };
    }

    if (after.money < 0) {
      return { passed: false, detail: `money went negative (${after.money})` };
    }

    // Money must reconcile against the effects the engine actually applied.
    const deltas = (input.appliedEffects ?? [])
      .filter((e): e is Extract<typeof e, { kind: 'MONEY_DELTA' }> => e.kind === 'MONEY_DELTA')
      .reduce((sum, e) => sum + e.delta, 0);
    const expected = before.money + deltas;
    if (after.money !== expected) {
      return {
        passed: false,
        detail: `money is ${after.money} but the applied effects imply ${expected} (deltas ${deltas})`,
      };
    }

    if (after.day < before.day) {
      return { passed: false, detail: `the in-world day went backwards (${before.day} -> ${after.day})` };
    }

    // Claims can only ever be added, and never an unknown one.
    const newClaims = after.revealedClaims.filter((c) => !before.revealedClaims.includes(c));
    for (const id of newClaims) {
      if (!this.evidence.hasClaim(id)) {
        return { passed: false, detail: `revealed claim ${id} does not exist in the knowledge base` };
      }
    }

    return { passed: true, detail: `turn +${turnDelta}, day ${before.day}->${after.day}, money ${before.money}->${after.money}` };
  }

  private checkOptionSelection(input: CriticInput): CriticCheck {
    const chosen = input.proposal.chosenOptionId;
    if (chosen === null) return { id: 'option-selection', name: 'Selected only engine-computed options', passed: true, detail: 'No option selected (rejected action).', severity: 'blocking' };

    const known = input.resolution.options.some((o) => o.id === chosen);
    if (!known) {
      return {
        id: 'option-selection',
        name: 'Selected only engine-computed options',
        passed: false,
        detail: `Game Master returned option id "${chosen}", which the engine did not offer. Fell back to "${input.resolution.options[0]?.id ?? 'none'}".`,
        severity: 'blocking',
      };
    }

    const option = input.resolution.options.find((o) => o.id === chosen);
    if (option && !option.available) {
      return {
        id: 'option-selection',
        name: 'Selected only engine-computed options',
        passed: false,
        detail: `Game Master selected "${chosen}", which the engine marked unavailable: ${option.unavailableReason ?? 'no reason given'}.`,
        severity: 'blocking',
      };
    }

    return {
      id: 'option-selection',
      name: 'Selected only engine-computed options',
      passed: true,
      detail: `Selected "${chosen}" from ${input.resolution.options.length} engine-computed option(s).`,
      severity: 'blocking',
    };
  }

  /**
   * Look for a cited claim whose text disagrees with the assertion.
   *
   * High-precision by design. It compares only *quantities that mean
   * something*: money and durations. Comparing every integer in a sentence
   * would make claim ids like `C-FEE-04` and section references like
   * "section 8(1)" look like contradicted figures, and an evaluation
   * instrument that cries wolf is worse than no instrument.
   */
  private findContradiction(assertion: string, claimId: string): Contradiction | null {
    const claim = this.evidence.getClaim(claimId);
    if (!claim) return null;

    const assertionNumbers = extractQuantities(assertion);
    const claimNumbers = extractQuantities(`${claim.text} ${claim.quote}`);
    if (assertionNumbers.length === 0 || claimNumbers.length === 0) return null;

    const everyAssertionNumberInSource = assertionNumbers.every((n) =>
      claimNumbers.some((c) => c === n || Math.abs(c - n) < 1),
    );
    if (everyAssertionNumberInSource) return null;

    return {
      claimId,
      assertion: truncate(assertion, 160),
      sourceSays: `${claim.documentTitle} ${claim.locator} states: ${truncate(claim.text, 160)}`,
    };
  }

  private summarise(
    passed: boolean,
    score: number,
    blockingFailed: number,
    majorFailed: number,
    unsupported: number,
    invented: number,
    contradictions: number,
  ): string {
    if (passed && blockingFailed === 0 && majorFailed === 0) {
      return `Turn passed with score ${score}. Every claim the Game Master made was either cited or clearly fictional.`;
    }
    const parts: string[] = [];
    if (blockingFailed > 0) parts.push(`${blockingFailed} blocking failure(s)`);
    if (majorFailed > 0) parts.push(`${majorFailed} major failure(s)`);
    if (unsupported > 0) parts.push(`${unsupported} unsupported citation(s)`);
    if (invented > 0) parts.push(`${invented} simulation statement(s) reading as fact`);
    if (contradictions > 0) parts.push(`${contradictions} contradiction(s) with the sources`);
    return `Turn failed with score ${score}: ${parts.join(', ')}.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Extract quantities that carry meaning: money and durations.
 *
 * Deliberately narrow. Claim ids, section numbers, gazette numbers and list
 * positions are integers too, and treating them as quantities produces
 * contradictions out of nothing.
 */
function extractQuantities(text: string): number[] {
  const out: number[] = [];
  const cleaned = text.replace(/C-[A-Z]+-\d+/g, ' ');

  // Money: "KSh 1,000", "950 shillings", "KSh 950"
  for (const m of cleaned.matchAll(
    /\bksh\.?\s*([\d][\d,]*)|([\d][\d,]*)\s*(?:shillings|pesa|bob)\b/gi,
  )) {
    const digits = (m[1] ?? m[2] ?? '').replace(/,/g, '');
    const value = Number.parseInt(digits, 10);
    if (Number.isFinite(value)) out.push(value);
  }

  // Durations: "twenty-eight days", "28 days", "within seven days"
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, twenty: 20,
    'twenty-eight': 28, twentyeight: 28, thirty: 30,
  };
  for (const m of cleaned.toLowerCase().matchAll(
    /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|twenty-eight|twentyeight|thirty)[\s-]*days?\b/g,
  )) {
    const raw = m[1]!;
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : words[raw];
    if (value !== undefined && Number.isFinite(value)) out.push(value);
  }

  return out;
}
