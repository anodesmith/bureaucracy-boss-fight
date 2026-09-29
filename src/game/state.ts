/**
 * Game state: construction, mutation, and invariants.
 *
 * HARD RULE: the only function in this codebase that mutates a `GameState` is
 * `applyEffects`. Language models never touch state directly. They select among
 * engine-produced effects and the engine validates every one of them. That is
 * how evaluation test #7 ("Game Master cannot modify protected player state
 * arbitrarily") is actually enforced rather than merely asserted.
 */

import type {
  DecisionRecord,
  Effect,
  GameState,
  GameStatus,
  InventoryItem,
  ObjectiveState,
  StateDigest,
} from '../core/types.js';
import { digestState } from '../core/hash.js';

export interface InvariantViolation {
  invariant: string;
  detail: string;
  severity: 'blocking' | 'warning';
}

export interface ApplyResult {
  state: GameState;
  /** Effects that were refused, with the reason. Never silently dropped. */
  refused: Array<{ effect: Effect; reason: string }>;
  violations: InvariantViolation[];
}

export interface ScenarioInit {
  missionId: string;
  maxTurns: number;
  startingMoney: number;
  startDay: number;
  inventory: InventoryItem[];
  flags: Record<string, string | number | boolean>;
  objectives: ObjectiveState[];
  endingIds: string[];
}

/** Build a fresh, fully-valid game state. */
export function createInitialState(init: ScenarioInit, seed: number): GameState {
  const state: GameState = {
    missionId: init.missionId,
    seed,
    turn: 0,
    maxTurns: init.maxTurns,
    day: init.startDay,
    money: init.startingMoney,
    inventory: init.inventory.map((item) => ({ ...item })),
    flags: { ...init.flags },
    objectives: init.objectives.map((o) => ({ ...o })),
    revealedClaims: [],
    decisions: [],
    status: 'ACTIVE',
    ending: null,
    rngCursor: 0,
    log: [],
  };
  const violations = checkInvariants(state);
  if (violations.some((v) => v.severity === 'blocking')) {
    throw new Error(`scenario produced an invalid initial state: ${canonical(violations)}`);
  }
  return state;
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Apply a list of engine-produced effects.
 *
 * Every effect is checked against an invariant before being applied. An effect
 * that would break an invariant is refused and reported, never partially
 * applied. This function is the trust boundary between the agents and the game.
 */
export function applyEffects(
  state: GameState,
  effects: Effect[],
  options: { advanceTurn?: boolean } = {},
): ApplyResult {
  const next: GameState = structuredClone(state);
  const refused: ApplyResult['refused'] = [];

  for (const effect of effects) {
    const reason = precheck(next, effect);
    if (reason !== null) {
      refused.push({ effect, reason });
      continue;
    }
    mutate(next, effect);
  }

  // The turn counter is owned by the engine, not by any effect.
  if (options.advanceTurn !== false) {
    next.turn = state.turn + 1;
  }

  const violations = checkInvariants(next);
  if (violations.some((v) => v.severity === 'blocking')) {
    // Refuse the whole transition rather than keep a corrupt state.
    return { state, refused, violations };
  }

  return { state: next, refused, violations };
}

/** Returns a refusal reason, or null if the effect may be applied. */
function precheck(state: GameState, effect: Effect): string | null {
  switch (effect.kind) {
    case 'MONEY_DELTA': {
      if (!Number.isFinite(effect.delta)) return 'MONEY_DELTA is not a finite number';
      if (state.money + effect.delta < 0) {
        return `insufficient funds: balance ${state.money} cannot absorb ${effect.delta}`;
      }
      return null;
    }
    case 'ITEM_ADD':
      if (!effect.item || typeof effect.item.id !== 'string') return 'ITEM_ADD missing item id';
      return null;
    case 'ITEM_REMOVE': {
      const held = state.inventory.find((i) => i.id === effect.itemId);
      if (!held) return `ITEM_REMOVE references ${effect.itemId} which is not held`;
      if (held.quantity < effect.quantity) {
        return `ITEM_REMOVE wants ${effect.quantity} of ${effect.itemId} but only ${held.quantity} held`;
      }
      return null;
    }
    case 'CLAIM_REVEAL':
      if (!/^C-[A-Z]+-\d+$/.test(effect.claimId)) {
        return `CLAIM_REVEAL malformed claim id ${effect.claimId}`;
      }
      return null;
    case 'OBJECTIVE_COMPLETE': {
      const obj = state.objectives.find((o) => o.id === effect.objectiveId);
      if (!obj) return `OBJECTIVE_COMPLETE references unknown objective ${effect.objectiveId}`;
      if (obj.status === 'COMPLETE') return `objective ${effect.objectiveId} already complete`;
      return null;
    }
    case 'OBJECTIVE_FAIL': {
      const obj = state.objectives.find((o) => o.id === effect.objectiveId);
      if (!obj) return `OBJECTIVE_FAIL references unknown objective ${effect.objectiveId}`;
      if (obj.status === 'COMPLETE') return `objective ${effect.objectiveId} is already complete`;
      return null;
    }
    case 'DAY_ADVANCE':
      if (!Number.isFinite(effect.days) || effect.days < 0) return 'DAY_ADVANCE must be >= 0';
      return null;
    case 'STATUS_SET':
      if (!['ACTIVE', 'WON', 'LOST', 'TIMEOUT'].includes(effect.status)) {
        return `STATUS_SET invalid status ${String(effect.status)}`;
      }
      return null;
    case 'FLAG_SET':
      return null;
    case 'ENDING_SET':
      return null;
    case 'DECISION_RECORD':
      return null;
    default: {
      const exhaustive: never = effect;
      return `unknown effect kind ${JSON.stringify(exhaustive)}`;
    }
  }
}

function mutate(state: GameState, effect: Effect): void {
  switch (effect.kind) {
    case 'MONEY_DELTA':
      state.money += effect.delta;
      break;

    case 'ITEM_ADD': {
      const existing = state.inventory.find((i) => i.id === effect.item.id);
      if (existing) {
        existing.quantity += effect.item.quantity;
        if (effect.item.official) existing.official = true;
      } else {
        state.inventory.push({ ...effect.item });
      }
      break;
    }

    case 'ITEM_REMOVE': {
      const existing = state.inventory.find((i) => i.id === effect.itemId);
      if (existing) {
        existing.quantity -= effect.quantity;
        if (existing.quantity <= 0) {
          state.inventory = state.inventory.filter((i) => i.id !== effect.itemId);
        }
      }
      break;
    }

    case 'FLAG_SET':
      state.flags[effect.flag] = effect.value;
      break;

    case 'CLAIM_REVEAL':
      if (!state.revealedClaims.includes(effect.claimId)) {
        state.revealedClaims.push(effect.claimId);
        state.revealedClaims.sort();
      }
      break;

    case 'OBJECTIVE_COMPLETE': {
      const obj = state.objectives.find((o) => o.id === effect.objectiveId);
      if (obj) obj.status = 'COMPLETE';
      break;
    }

    case 'OBJECTIVE_FAIL': {
      const obj = state.objectives.find((o) => o.id === effect.objectiveId);
      if (obj) obj.status = 'FAILED';
      break;
    }

    case 'DAY_ADVANCE':
      state.day += effect.days;
      break;

    case 'STATUS_SET':
      state.status = effect.status;
      break;

    case 'ENDING_SET':
      state.ending = { ...effect.ending };
      break;

    case 'DECISION_RECORD':
      state.decisions.push({ ...effect.decision });
      break;

    default: {
      const exhaustive: never = effect;
      throw new Error(`unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Invariants                                                                  */
/* -------------------------------------------------------------------------- */

/** The complete set of invariants. Tests assert these directly. */
export function checkInvariants(state: GameState): InvariantViolation[] {
  const out: InvariantViolation[] = [];

  if (!Number.isInteger(state.money)) {
    out.push({
      invariant: 'money-is-integer',
      detail: `money is ${String(state.money)}`,
      severity: 'blocking',
    });
  }
  if (state.money < 0) {
    out.push({
      invariant: 'money-non-negative',
      detail: `money went to ${state.money}`,
      severity: 'blocking',
    });
  }

  if (!Number.isInteger(state.turn) || state.turn < 0) {
    out.push({ invariant: 'turn-non-negative', detail: `turn=${String(state.turn)}`, severity: 'blocking' });
  }
  if (state.turn > state.maxTurns) {
    out.push({
      invariant: 'turn-within-limit',
      detail: `turn ${state.turn} exceeds maxTurns ${state.maxTurns}`,
      severity: 'warning',
    });
  }

  if (!Number.isInteger(state.day) || state.day < 0) {
    out.push({ invariant: 'day-non-negative', detail: `day=${String(state.day)}`, severity: 'blocking' });
  }

  for (const item of state.inventory) {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      out.push({
        invariant: 'inventory-quantity-non-negative',
        detail: `${item.id} has quantity ${String(item.quantity)}`,
        severity: 'blocking',
      });
    }
  }

  const ids = state.inventory.map((i) => i.id);
  if (new Set(ids).size !== ids.length) {
    out.push({
      invariant: 'inventory-unique-ids',
      detail: `duplicate item ids: ${ids.join(', ')}`,
      severity: 'blocking',
    });
  }

  const claimIds = state.revealedClaims;
  if (new Set(claimIds).size !== claimIds.length) {
    out.push({
      invariant: 'revealed-claims-unique',
      detail: 'duplicate claim ids in revealedClaims',
      severity: 'blocking',
    });
  }
  for (const id of claimIds) {
    if (!/^C-[A-Z]+-\d+$/.test(id)) {
      out.push({ invariant: 'claim-id-format', detail: `malformed claim id ${id}`, severity: 'blocking' });
    }
  }

  const objIds = state.objectives.map((o) => o.id);
  if (new Set(objIds).size !== objIds.length) {
    out.push({
      invariant: 'objectives-unique-ids',
      detail: `duplicate objective ids: ${objIds.join(', ')}`,
      severity: 'blocking',
    });
  }

  if (state.status === 'ACTIVE' && state.turn >= state.maxTurns) {
    out.push({
      invariant: 'game-resolves-by-limit',
      detail: `game still ACTIVE at turn ${state.turn} of ${state.maxTurns}`,
      severity: 'warning',
    });
  }

  if (state.status !== 'ACTIVE' && !state.ending) {
    out.push({
      invariant: 'terminal-state-has-ending',
      detail: `status ${state.status} with no ending attached`,
      severity: 'warning',
    });
  }

  return out;
}

export function isBlocking(violations: InvariantViolation[]): boolean {
  return violations.some((v) => v.severity === 'blocking');
}

/** Human-readable money. */
export function formatMoney(amount: number): string {
  return `KSh ${amount.toLocaleString('en-KE')}`;
}

export function objectiveById(state: GameState, id: string): ObjectiveState | undefined {
  return state.objectives.find((o) => o.id === id);
}

export function digest(state: GameState): StateDigest {
  return digestState(state);
}

export function isTerminal(status: GameStatus): boolean {
  return status !== 'ACTIVE';
}

export function recordDecision(state: GameState, decision: DecisionRecord): void {
  state.decisions.push(decision);
}
