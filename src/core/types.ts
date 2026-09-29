/**
 * Core domain types for Bureaucracy Boss Fight.
 *
 * The single most important type in this file is `Grounding`. Every factual
 * statement the system makes about the real world carries one. The whole point
 * of the project is that a claim of unknown confidence can never be silently
 * upgraded to a claim of known confidence.
 */

/** The four epistemic states every real-world statement must be assigned. */
export type Grounding =
  /** Directly supported by a quoted source in the knowledge base. */
  | 'VERIFIED'
  /** A reasonable derivation from verified sources, but not itself stated. */
  | 'INFERRED'
  /** Insufficient evidence. Must not be presented as fact. */
  | 'UNKNOWN'
  /** Deliberately invented by the simulation. Not a claim about reality. */
  | 'FICTIONAL_GAME_EVENT';

/** Trust level of a knowledge document as a whole. */
export type DocumentVerification = 'VERIFIED' | 'CONFLICTED' | 'UNVERIFIED';

export type DocumentType =
  | 'primary_legislation'
  | 'government_portal'
  | 'secondary_aggregated'
  | 'official_notice'
  | 'news'
  | 'commentary';

/* -------------------------------------------------------------------------- */
/* Knowledge base                                                              */
/* -------------------------------------------------------------------------- */

export interface EvidenceDocument {
  id: string;
  title: string;
  source: string;
  sourceUrl: string;
  documentType: DocumentType;
  jurisdiction: string;
  versionDate: string;
  retrievedAt: string;
  retrievalMethod: string;
  verification: DocumentVerification;
  verificationNote: string;
  copyrightNote: string;
  /** Claims extracted from this document, in file order. */
  claims: EvidenceClaim[];
  /** Prose summary of the document, used for display only. */
  summary: string;
}

export interface EvidenceClaim {
  /** Globally unique, e.g. "C-RBN-03". */
  id: string;
  /** The claim restated in plain language, as the system may state it. */
  text: string;
  grounding: Grounding;
  /** Id of the document this claim came from. */
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  documentVerification: DocumentVerification;
  /** Section / clause reference within the source, e.g. "section 8(1)". */
  locator: string;
  /** Verbatim quotation supporting the claim. Empty for UNKNOWN claims. */
  quote: string;
  /** For UNKNOWN claims: why the system does not know. */
  unknownReason: string;
  /** For INFERRED claims: how it was derived. */
  derivation: string;
  /** Search terms, lower-cased. */
  topics: string[];
}

/** A claim as returned to the Game Master by the evidence agent. */
export interface RetrievedClaim {
  claim: EvidenceClaim;
  score: number;
  /** Why the retriever thought this was relevant. Surfaced in Lab Mode. */
  matchedTerms: string[];
}

export interface EvidenceBundle {
  query: string;
  claims: RetrievedClaim[];
  /** Claim ids explicitly judged relevant enough to cite. */
  usable: string[];
  /** Topics the player asked about for which the base holds nothing usable. */
  gaps: GapReport[];
}

export interface GapReport {
  topic: string;
  reason: string;
  /** Search terms tried. */
  attempted: string[];
}

/* -------------------------------------------------------------------------- */
/* Game state                                                                  */
/* -------------------------------------------------------------------------- */

export type GameStatus = 'ACTIVE' | 'WON' | 'LOST' | 'TIMEOUT';

export type ResourceKind = 'MONEY' | 'ITEM' | 'PERMIT' | 'TIME';

export interface InventoryItem {
  id: string;
  label: string;
  quantity: number;
  /** True if this item satisfies a real statutory duty (e.g. a certificate). */
  official: boolean;
  description: string;
}

export interface GameState {
  missionId: string;
  seed: number;
  turn: number;
  maxTurns: number;
  /** Days elapsed in the fictional in-world calendar. */
  day: number;
  money: number;
  inventory: InventoryItem[];
  flags: Record<string, string | number | boolean>;
  objectives: ObjectiveState[];
  /** Claim ids the player has actually learned. The hidden-information core. */
  revealedClaims: string[];
  /** Grounding classification of the player's key decisions so far. */
  decisions: DecisionRecord[];
  status: GameStatus;
  ending: Ending | null;
  /** Serialised PRNG cursor so replay is exact. */
  rngCursor: number;
  log: TurnRecord[];
}

export interface ObjectiveState {
  id: string;
  title: string;
  description: string;
  status: 'LOCKED' | 'ACTIVE' | 'COMPLETE' | 'FAILED';
  /**
   * EVIDENCE objectives are completed by holding the sources they name.
   * ACTION objectives are completed by doing the thing, and are never
   * completed by reading about it.
   *
   * Keeping these apart matters: "learn that the certificate must be displayed"
   * and "display the certificate" are different achievements, and collapsing
   * them would let a player pass the game by reading.
   */
  kind: 'EVIDENCE' | 'ACTION';
  /** Claim ids that must be revealed before this can be attempted. */
  requiresClaims: string[];
  /** For EVIDENCE objectives: the claims that must all be held to complete it. */
  completeWhenClaimsKnown?: string[];
  optional: boolean;
}

export interface DecisionRecord {
  turn: number;
  actionType: string;
  /** How well grounded the player's move was in retrieved evidence. */
  grounding: Grounding;
  note: string;
}

export interface Ending {
  id: string;
  title: string;
  blurb: string;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type ActionType =
  | 'RESEARCH'
  | 'ASK'
  | 'BUY'
  | 'TRAVEL'
  | 'APPLY'
  | 'CONTACT'
  | 'INSPECT'
  | 'WAIT'
  | 'CUSTOM';

export interface ActionIntent {
  type: ActionType;
  /** What the player said, verbatim. */
  text: string;
  /** Items extracted by the parser, e.g. { amount: 5000, item: 'trolley' }. */
  slots: Record<string, string | number | boolean>;
  /** 0..1 confidence in the parse. Low confidence triggers a clarification. */
  confidence: number;
  /** Alternative readings considered by the parser. */
  alternatives: Array<{ type: ActionType; slots: Record<string, string | number | boolean> }>;
}

/* -------------------------------------------------------------------------- */
/* Engine output                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY way anything changes in the game. Effects are produced by the
 * deterministic engine, never by a language model. A model may *select* among
 * engine-produced options; it may never author one.
 */
export type Effect =
  | { kind: 'MONEY_DELTA'; delta: number; ruleId: string; reason: string; grounding: Grounding }
  | { kind: 'ITEM_ADD'; item: InventoryItem; ruleId: string; reason: string; grounding: Grounding }
  | { kind: 'ITEM_REMOVE'; itemId: string; quantity: number; ruleId: string; reason: string; grounding: Grounding }
  | { kind: 'FLAG_SET'; flag: string; value: string | number | boolean; ruleId: string; reason: string }
  | { kind: 'CLAIM_REVEAL'; claimId: string; ruleId: string; reason: string }
  | { kind: 'OBJECTIVE_COMPLETE'; objectiveId: string; ruleId: string; reason: string }
  | { kind: 'OBJECTIVE_FAIL'; objectiveId: string; ruleId: string; reason: string }
  | { kind: 'DAY_ADVANCE'; days: number; ruleId: string; reason: string }
  | { kind: 'STATUS_SET'; status: GameStatus; ruleId: string; reason: string }
  | { kind: 'ENDING_SET'; ending: Ending; ruleId: string; reason: string }
  | { kind: 'DECISION_RECORD'; decision: DecisionRecord; ruleId: string; reason: string };

export interface GameEvent {
  id: string;
  title: string;
  body: string;
  kind: 'OBSTACLE' | 'OPPORTUNITY' | 'DEADLINE' | 'SYSTEM' | 'DISCOVERY';
  /** Fictional events are always marked. Never presented as reality. */
  grounding: 'FICTIONAL_GAME_EVENT' | 'VERIFIED' | 'UNKNOWN';
  claimIds: string[];
  severity: 'info' | 'warn' | 'danger';
}

/** A block of narration with an explicit epistemic label. */
export interface NarrationBlock {
  text: string;
  grounding: Grounding;
  /** Required to be non-empty when grounding is VERIFIED or INFERRED. */
  claimIds: string[];
}

/** An engine-produced option the Game Master may choose between. */
export interface EffectOption {
  id: string;
  /** Short structured summary for Lab Mode. Not chain-of-thought. */
  summary: string;
  effects: Effect[];
  /** Events that fire with this option. */
  events: GameEvent[];
  narration: NarrationBlock[];
  /** Options that cost a turn are marked; the GM may not invent free turns. */
  available: boolean;
  unavailableReason?: string;
}

export interface ActionResolution {
  turn: number;
  intent: ActionIntent;
  /** Options the Game Master may choose from. At least one. */
  options: EffectOption[];
  /** Set when the action itself was rejected before any option was produced. */
  rejection: ActionRejection | null;
  /** Narration that is fixed by the engine regardless of which option is used. */
  preamble: NarrationBlock[];
  /** Rule ids that fired, for Lab Mode. */
  rulesFired: string[];
  /** Topics the evidence agent should be asked about. */
  evidenceQueries: string[];
}

export interface ActionRejection {
  code:
    | 'UNKNOWN_ACTION'
    | 'AMBIGUOUS_ACTION'
    | 'INSUFFICIENT_FUNDS'
    | 'INVALID_SLOT'
    | 'GAME_OVER'
    | 'NOTHING_TO_DO'
    | 'LOCKED';
  message: string;
  /** Clarifying question the Game Master should put to the player. */
  clarification?: string;
  /** True when the rejection still costs the player a turn. */
  costsTurn: boolean;
}

/* -------------------------------------------------------------------------- */
/* Agent contracts                                                             */
/* -------------------------------------------------------------------------- */

export interface TurnContext {
  state: GameState;
  intent: ActionIntent;
  resolution: ActionResolution;
  evidence: EvidenceBundle;
  scenarioTitle: string;
  scenarioBrief: string;
  playerProfile: string;
}

export interface GameMasterProposal {
  /** Which engine option the Game Master selected. */
  chosenOptionId: string | null;
  /**
   * Narration to show the player, in order.
   *
   * There is deliberately no free-text `reply` field. An answer to the
   * player's question is just narration: a set of blocks, each carrying its
   * own grounding label and its citations. A single unlabelled string would be
   * one more place for an ungrounded sentence to hide, and the Critic could
   * not audit it.
   */
  narration: NarrationBlock[];
  /** Topics the player asked about that the GM could not answer. */
  unresolved: string[];
}

export interface CriticVerdict {
  turn: number;
  /** Overall pass/fail for the turn. */
  passed: boolean;
  checks: CriticCheck[];
  /** Claim ids the GM asserted without any supporting evidence. */
  unsupportedClaims: string[];
  /** Requirements the GM asserted that no source mentions. */
  inventedRequirements: string[];
  /** Where the GM contradicted the knowledge base. */
  contradictions: Contradiction[];
  /** Whether the proposed state transition was legal. */
  stateTransitionLegal: boolean;
  /** Whether the narration respected the four grounding categories. */
  groundingRespected: boolean;
  score: number;
  summary: string;
}

export interface CriticCheck {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
  severity: 'blocking' | 'major' | 'minor';
}

export interface Contradiction {
  claimId: string;
  assertion: string;
  sourceSays: string;
}

/* -------------------------------------------------------------------------- */
/* Turn record / replay                                                        */
/* -------------------------------------------------------------------------- */

export interface TurnRecord {
  turn: number;
  intent: ActionIntent;
  optionId: string | null;
  narration: NarrationBlock[];
  events: GameEvent[];
  effects: Effect[];
  evidence: RetrievedClaim[];
  critique: CriticVerdict | null;
  stateAfter: StateDigest;
  rngCursor: number;
  rejection: ActionRejection | null;
  provider: string;
  dayAfter: number;
  moneyAfter: number;
}

/** Compact snapshot used for hashing and for Lab Mode diffing. */
export interface StateDigest {
  turn: number;
  day: number;
  money: number;
  status: GameStatus;
  inventory: Array<[string, number]>;
  flags: Record<string, string | number | boolean>;
  objectives: Array<[string, ObjectiveState['status']]>;
  revealedClaims: string[];
  ending: string | null;
}
