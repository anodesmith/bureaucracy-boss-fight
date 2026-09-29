/**
 * Stable, order-insensitive hashing and canonical JSON.
 *
 * Used to (a) prove determinism in tests, and (b) give the evaluation harness a
 * short fingerprint of a run so replays can be compared without diffing
 * thousands of lines of JSON.
 */

import type { GameState, StateDigest } from './types.js';

/** JSON.stringify with deterministic key ordering. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

/** FNV-1a 32-bit, returned as 8 lowercase hex characters. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Reduce a game state to the fields that define the simulation outcome. */
export function digestState(state: GameState): StateDigest {
  return {
    turn: state.turn,
    day: state.day,
    money: state.money,
    status: state.status,
    inventory: state.inventory
      .map((item) => [item.id, item.quantity] as [string, number])
      .sort((a, b) => a[0].localeCompare(b[0])),
    flags: { ...state.flags },
    objectives: state.objectives
      .map((o) => [o.id, o.status] as [string, (typeof o)['status']])
      .sort((a, b) => a[0].localeCompare(b[0])),
    revealedClaims: [...state.revealedClaims].sort(),
    ending: state.ending?.id ?? null,
  };
}

/** Fingerprint of the simulation-defining state. */
export function stateHash(state: GameState): string {
  return fnv1a(canonicalJson(digestState(state)));
}

/** Deep structural equality via canonical JSON. */
export function statesEqual(a: GameState, b: GameState): boolean {
  return canonicalJson(digestState(a)) === canonicalJson(digestState(b));
}
