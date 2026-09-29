/**
 * Turns what the player typed into a structured `ActionIntent`.
 *
 * This is deliberately a transparent rule-based parser rather than an LLM call.
 * Two reasons:
 *   1. Determinism. The action sequence is half of the replay key.
 *   2. Honesty. When the parse is ambiguous the player is told so, instead of
 *      the system silently guessing and then acting on the guess.
 *
 * Free text is always preserved in `intent.text`, so the Game Master can still
 * read the whole sentence even when the parser only understood part of it.
 */

import type { ActionIntent, ActionType } from '../../core/types.js';

/**
 * A keyword match carries a weight. A strong match is an unambiguous verb in
 * that position ("apply", "research", "buy"); a weak one is a word that merely
 * appears in that field's vocabulary ("registrar" in a sentence about waiting
 * for the registrar is not an application).
 *
 * Without this distinction "wait for the registrar" parses as APPLY, which is
 * how a game about precision ends up making an unearned move on the player.
 */
interface Family {
  type: ActionType;
  stems: Array<[string, number]>;
  weight: number;
}

const FAMILIES: Family[] = [
  { type: 'RESEARCH', weight: 1.2, stems: [
    ['research', 3], ['look up', 3], ['look-up', 3], ['find out', 3], ['verify', 3],
    ['investigate', 3], ['read the', 2.5], ['read up', 2.5], ['study', 2],
    ['check the law', 3], ['check law', 3], ['what does the law', 3], ['google', 2.5],
    ['search for', 2.5], ['search online', 2.5], ['look into', 2.5],
  ] },
  { type: 'ASK', weight: 1.1, stems: [
    ['ask', 3], ['inquire', 3], ['enquire', 3], ['how much', 2.5], ['how many', 2.5],
    ['what is', 2], ['what are', 2], ['do i need', 2.5], ['do i have to', 2.5],
    ['am i required', 2.5], ['can i', 1.2], ['may i', 1.2], ['is it legal', 2.5],
    ['is it true', 2.5], ['does the law', 2.5],
  ] },
  { type: 'BUY', weight: 1.3, stems: [
    ['buy', 3], ['purchas', 3], ['acquir', 3], ['hire', 2.5], ['rent', 2.5],
    ['order', 2], ['pay for', 1.5],
  ] },
  { type: 'APPLY', weight: 1.3, stems: [
    ['apply', 3], ['submit', 2.5], ['file for', 2.5], ['lodge', 2.5],
    ['register the', 2.5], ['register my', 2.5], ['reserve my', 2.5], ['reserve the', 2.5],
    ['renew', 2.5],
    // Weak: these words show up in sentences that are not applications.
    ['registr', 0.4], ['application', 0.6],
  ] },
  { type: 'CONTACT', weight: 1.1, stems: [
    ['contact', 3], ['call', 2.5], ['phone', 2.5], ['email', 2.5], ['message', 2],
    ['meet', 2.5], ['speak to', 3], ['visit the office', 3], ['go to the office', 3],
    ['front desk', 3], ['help desk', 3], ['ask for', 2.5],
  ] },
  { type: 'TRAVEL', weight: 1.2, stems: [
    ['travel', 3], ['go to', 2.5], ['move to', 2.5], ['commute', 3], ['journey', 2],
    ['take a matatu', 3], ['catch a matatu', 3], ['fly to', 3], ['drive to', 3], ['relocate', 3],
  ] },
  { type: 'INSPECT', weight: 1.1, stems: [
    ['inspect', 3], ['examine', 3], ['survey', 2.5], ['look around', 3],
    ['check the site', 3], ['assess', 2], ['scout', 2.5], ['measure', 2],
    // Displaying the certificate is an inspection of your own premises in the
    // broadest sense. The scenario rule for it matches on text either way, but
    // a low-confidence CUSTOM parse reads as a bug in Lab Mode.
    ['display', 3], ['exhibit', 3], ['hang', 2.5], ['put up', 2.5],
  ] },
  { type: 'WAIT', weight: 1.2, stems: [
    ['wait', 3], ['do nothing', 3], ['sit tight', 3], ['idle', 3], ['sleep', 2.5],
    ['hold off', 3], ['wait and see', 3], ['be patient', 3], ['let it', 1.5],
  ] },
];

const AMOUNT_PATTERNS: RegExp[] = [
  /\bksh\.?\s*([\d][\d,\s]*)/i,
  /\b([\d][\d,\s]*)\s*(?:kshs?|shillings|bob|kpesh)\b/i,
  /\b([\d][\d,\s]*)\s*pesa\b/i,
  /\b([\d][\d,]*)\s*k\b(?!\w)/i,
];

/** Words that mean "the thing being bought", used to trim a noun phrase. */
const LEADING_NOISE = /^(?:a|an|the|some|my|new|second|another|used|old)\s+/i;

const ITEM_STOP_WORDS = new Set([
  'in', 'for', 'with', 'from', 'at', 'to', 'on', 'and', 'then', 'because', 'so', 'but',
  'ksh', 'shillings', 'pesa', 'today', 'now', 'first', 'also', 'after', 'before', 'while',
]);

/**
 * Parse raw player input.
 *
 * Never throws. Always returns an intent; `confidence` communicates doubt.
 */
export function parseAction(raw: string): ActionIntent {
  const text = raw.trim();
  const lower = text.toLowerCase();

  const scored = FAMILIES.map((family) => {
    let score = 0;
    for (const [stem, weight] of family.stems) {
      if (lower.includes(stem)) score += weight;
    }
    return { type: family.type, score: score * family.weight };
  })
    .filter((s) => s.score >= 0.4)
    .sort((a, b) => b.score - a.score);

  const amount = extractAmount(text);
  const item = extractItem(lower);

  // A question mark is a very strong ASK signal in this game: the player is
  // probing what is true.
  if (text.includes('?') && (scored.length === 0 || scored[0]!.type !== 'ASK')) {
    scored.unshift({ type: 'ASK', score: scored.length === 0 ? 1.5 : scored[0]!.score + 0.4 });
  }

  const slots: Record<string, string | number | boolean> = {};
  if (amount !== null) slots.amount = amount;
  if (item !== null) slots.item = item;
  if (text.length > 0) slots.raw = text;

  if (scored.length === 0) {
    return {
      type: 'CUSTOM',
      text,
      slots,
      confidence: 0.25,
      alternatives: [],
    };
  }

  const best = scored[0]!;
  const second = scored[1];

  let confidence: number;
  if (best.score < 1.2) {
    // Only a weak, ambiguous match.
    confidence = 0.4;
  } else if (second === undefined) {
    confidence = 0.9;
  } else {
    const margin = (best.score - second.score) / best.score;
    confidence = 0.55 + Math.min(0.4, margin * 0.8);
  }

  // A money amount plus a noun but no clear verb still smells like a purchase.
  if (best.type === 'CUSTOM' && amount !== null && item !== null) {
    return { type: 'BUY', text, slots, confidence: 0.6, alternatives: [] };
  }

  const alternatives: ActionIntent['alternatives'] = scored
    .slice(1, 4)
    .map((s) => ({
      type: s.type,
      slots: amount !== null ? ({ amount } as Record<string, string | number | boolean>) : {},
    }));

  return {
    type: best.type,
    text,
    slots,
    confidence: Math.min(1, confidence),
    alternatives,
  };
}

/** Extract a Kenyan-shilling amount, tolerating `8,000`, `Ksh 5000`, `8k`. */
export function extractAmount(text: string): number | null {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const digits = match[1].replace(/[,\s]/g, '');
    const value = Number.parseInt(digits, 10);
    if (Number.isFinite(value) && value > 0) {
      if (/\bk\b(?!\w)/i.test(match[0]) && !/ksh/i.test(match[0])) {
        return value * 1000;
      }
      return value;
    }
  }
  return null;
}

/**
 * Extract the thing being acted on. Deliberately crude: it grabs a short noun
 * phrase after a purchase verb. If it cannot, the engine asks the player to
 * clarify rather than inventing an item.
 */
export function extractItem(lower: string): string | null {
  const purchase =
    /\b(?:buy|purchas\w*|acquir\w*|hire|rent|order)\b\s*(?:me\s+|for\s+me\s+)?(.{2,60})/i.exec(lower);
  if (purchase?.[1]) {
    const phrase = purchase[1]
      .split(/[.,;!?]|\s+and\s+|\s+then\s+|\s+but\s+|\s+so\s+|\s+because\s+/)[0]!
      .trim()
      .replace(LEADING_NOISE, '')
      .trim();
    if (phrase.length >= 2 && phrase.length <= 60) return phrase;
  }
  return null;
}

/** Explicit menu actions never need parsing. */
export function menuIntent(type: ActionType, slots: Record<string, string | number | boolean> = {}): ActionIntent {
  return { type, text: '', slots, confidence: 1, alternatives: [] };
}

/** Basic sanity check on a parsed intent, independent of game state. */
export function validateIntentShape(intent: ActionIntent): string | null {
  if (intent.text.length > 600) return 'Action text is too long (600 character limit).';
  if (intent.text.length === 0 && intent.type !== 'WAIT') {
    return 'Empty action. Describe what you want to do.';
  }
  if (intent.type === 'BUY') {
    const amount = intent.slots.amount;
    if (amount !== undefined) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return 'A purchase needs a positive amount, for example "buy a trolley for KSh 5,000".';
      }
      if (amount > 10_000_000) {
        return 'That amount is implausible for this mission.';
      }
    }
    if (intent.slots.item === undefined) {
      return 'What exactly are you buying? Try "buy a trolley for KSh 5,000".';
    }
  }
  return null;
}
