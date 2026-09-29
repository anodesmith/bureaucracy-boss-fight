/**
 * Deterministic pseudo-random number generation.
 *
 * The whole simulation must be reproducible from `(seed, action sequence)`.
 * Two runs with the same seed and the same inputs must produce byte-identical
 * state. That is test #8 in the evaluation suite, and it is a hard requirement,
 * not a nice-to-have.
 *
 * We use SplitMix32: tiny, fast, good enough distribution for game events, and
 * trivially serialisable so the cursor can live inside `GameState`.
 */

export interface Rng {
  /** Current internal state. Store this in the game state for replay. */
  readonly cursor: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Deterministic pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Number of raw draws taken so far. */
  draws(): number;
}

const MASK = 0xffffffff;

/** SplitMix32 finalizer. */
function mix(input: number): number {
  let z = (input + 0x9e3779b9) & MASK;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) & MASK;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) & MASK;
  return (z ^ (z >>> 15)) & MASK;
}

/**
 * Create an RNG from a seed and a starting cursor.
 * `cursor` is the serialised PRNG state, not a draw count.
 */
export function createRng(seed: number, cursor = 0): Rng {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`seed must be a non-negative integer, received ${String(seed)}`);
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error(`cursor must be a non-negative integer, received ${String(cursor)}`);
  }

  let state = mix(mix(seed) ^ cursor) & MASK;
  let taken = 0;

  const next = (): number => {
    // Advance one step, then scramble.
    state = (state + 0x9e3779b9) & MASK;
    const z = state;
    taken += 1;
    return mix(z) / 0x100000000;
  };

  return {
    get cursor(): number {
      return cursor + taken;
    },
    next,
    int(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        throw new Error('rng.int bounds must be integers');
      }
      if (max < min) return min;
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick called with an empty array');
      return items[Math.floor(next() * items.length)] as T;
    },
    draws(): number {
      return taken;
    },
  };
}

/** Hash a string to a 32-bit unsigned integer. Used to seed from text. */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) & MASK;
  }
  return h >>> 0;
}
