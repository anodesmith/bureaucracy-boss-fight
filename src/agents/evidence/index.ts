/**
 * EVIDENCE AGENT
 * ==============
 * Responsible for: retrieving relevant evidence, identifying what is actually
 * supported, and returning source references.
 *
 * Its single hard rule: **it never invents an official requirement.**
 *
 * Mechanically that is guaranteed by construction. This agent cannot emit a
 * citation, because every citation it can produce must already exist as a
 * labelled claim in `knowledge/`. It can rank claims, filter claims, and report
 * gaps. It cannot write new ones.
 *
 * It also refuses to launder unknowns. `usable` contains only claims that may be
 * presented as real-world statements, and an UNKNOWN claim is never in it, no
 * matter how confidently it appears in the source.
 */

import type {
  EvidenceBundle,
  EvidenceClaim,
  GapReport,
  Grounding,
  RetrievedClaim,
} from '../../core/types.js';
import { Retriever, tokenize } from './retrieval.js';
import type { KnowledgeBase } from './knowledge.js';

export interface EvidenceAgentOptions {
  /** Max claims returned per query. */
  limit?: number;
  /** Minimum BM25 score to be considered retrieved at all. */
  minScore?: number;
}

export interface RetrievalTrace {
  query: string;
  queryTerms: string[];
  considered: number;
  returned: number;
  usable: number;
  gaps: GapReport[];
  durationMs: number;
}

export class EvidenceAgent {
  private readonly retriever: Retriever;
  readonly kb: KnowledgeBase;
  private readonly limit: number;
  private readonly minScore: number;
  /** Populated for Lab Mode. Never returned to the Game Master's prompt. */
  lastTrace: RetrievalTrace | null = null;

  constructor(kb: KnowledgeBase, options: EvidenceAgentOptions = {}) {
    this.kb = kb;
    this.limit = options.limit ?? 8;
    this.minScore = options.minScore ?? 0.35;
    this.retriever = new Retriever(kb.claims);
  }

  /**
   * A claim may be cited as a real-world statement only under these conditions.
   * This predicate is the heart of the grounding guarantee.
   */
  isUsable(claim: EvidenceClaim): boolean {
    if (claim.grounding === 'FICTIONAL_GAME_EVENT') return false;
    if (claim.grounding === 'UNKNOWN') return false;
    if (!CLAIM_ID_PATTERN.test(claim.id)) return false;
    if (claim.documentVerification === 'CONFLICTED' && claim.grounding === 'VERIFIED') return false;
    if (claim.grounding === 'VERIFIED') {
      // A verified claim must have a quote and a real locator.
      if (claim.quote.trim() === '') return false;
      if (claim.locator === 'unstated' || claim.locator.trim() === '') return false;
    }
    return true;
  }

  /**
   * Is this hit specific enough to the query to be citable?
   *
   * A lexical retriever will always return its best guess for any input, so
   * relevance has to be judged rather than assumed. A claim sharing a single
   * incidental term with a multi-term query - "capital" matching the word
   * "capital" in a clause about headquarters - is a coincidence, not evidence.
   * Those hits are demoted: they stay visible in Lab Mode as `weak` and they
   * become a reported gap, but they are never citable.
   */
  private isRelevant(hit: RetrievedClaim, queryTermCount: number): boolean {
    if (queryTermCount <= 1) return hit.matchedTerms.length >= 1;
    return hit.matchedTerms.length >= 2;
  }

  /** Retrieve for a query. Returns claims, usable ids, and explicit gaps. */
  retrieve(query: string, options: { limit?: number } = {}): EvidenceBundle {
    const started = Date.now();
    const limit = options.limit ?? this.limit;
    const raw = this.retriever.search(query, limit, true);
    const hits = raw.filter((r) => r.score >= this.minScore);
    const queryTermCount = new Set(tokenize(query)).size;

    const usable: string[] = [];
    const weak: string[] = [];
    for (const hit of hits) {
      if (!this.isRelevant(hit, queryTermCount)) {
        weak.push(hit.claim.id);
        continue;
      }
      if (this.isUsable(hit.claim) && !usable.includes(hit.claim.id)) {
        usable.push(hit.claim.id);
      }
    }

    const gaps = this.findGaps(query, hits, raw);
    if (weak.length > 0) {
      gaps.push({
        topic: query.slice(0, 60),
        reason:
          'the only matches in the knowledge base share a single incidental word with this question, which is a coincidence rather than evidence. Nothing citable was found.',
        attempted: weak,
      });
    }

    this.lastTrace = {
      query,
      queryTerms: [...new Set(tokenize(query))].slice(0, 24),
      considered: this.kb.claims.length,
      returned: hits.length,
      usable: usable.length,
      gaps,
      durationMs: Date.now() - started,
    };

    return { query, claims: hits, usable, gaps };
  }

  /**
   * Combine several queries (an action often needs several angles) and merge
   * the results, keeping the best score per claim.
   *
   * A merged claim is usable if it cleared the relevance gate for at least one
   * of the queries that produced it. That matters: a claim that matched only
   * weakly on one query may match decisively on another, and dropping it
   * would hide evidence the player should have seen.
   */
  retrieveAll(queries: string[], options: { limit?: number } = {}): EvidenceBundle {
    const limit = options.limit ?? this.limit;
    const merged = new Map<string, { hit: RetrievedClaim; relevant: boolean }>();
    const allGaps: GapReport[] = [];
    const seenGapKey = new Set<string>();

    for (const query of queries) {
      if (query.trim() === '') continue;
      const termCount = new Set(tokenize(query)).size;
      const raw = this.retriever.search(query, limit, true);
      const hits = raw.filter((r) => r.score >= this.minScore);

      for (const hit of hits) {
        const relevant = this.isRelevant(hit, termCount);
        const existing = merged.get(hit.claim.id);
        if (!existing) {
          merged.set(hit.claim.id, { hit, relevant });
        } else {
          existing.relevant = existing.relevant || relevant;
          if (hit.score > existing.hit.score) existing.hit = hit;
        }
      }

      for (const gap of this.findGaps(query, hits, raw)) {
        const key = `${gap.topic}|${gap.reason.slice(0, 80)}`;
        if (!seenGapKey.has(key)) {
          seenGapKey.add(key);
          allGaps.push(gap);
        }
      }
    }

    const claims = [...merged.values()]
      .map((entry) => entry.hit)
      .sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id));

    const usable = claims
      .filter((hit) => merged.get(hit.claim.id)?.relevant === true)
      .map((hit) => hit.claim.id)
      .filter((id) => {
        const claim = this.kb.byClaimId.get(id);
        return claim !== undefined && this.isUsable(claim);
      });

    return { query: queries.join(' | '), claims, usable, gaps: allGaps };
  }

  /** Look up a claim by id. Used by the Critic to validate citations. */
  getClaim(id: string): EvidenceClaim | undefined {
    return this.kb.byClaimId.get(id);
  }

  hasClaim(id: string): boolean {
    return this.kb.byClaimId.has(id);
  }

  /**
   * Is a proposed citation real, and does it actually say what the agent
   * claims it says? The Critic calls this for every VERIFIED assertion.
   */
  validateCitation(
    id: string,
    assertion: string,
  ): { ok: boolean; reason: string; claim?: EvidenceClaim } {
    const claim = this.getClaim(id);
    if (!claim) return { ok: false, reason: `no claim with id ${id} exists in the knowledge base` };
    if (claim.grounding === 'UNKNOWN') {
      return {
        ok: false,
        reason: `claim ${id} is UNKNOWN (${claim.unknownReason || 'no reason recorded'}) and cannot support a factual assertion`,
        claim,
      };
    }
    if (claim.grounding === 'FICTIONAL_GAME_EVENT') {
      return { ok: false, reason: `claim ${id} is a simulation event, not a real-world fact`, claim };
    }
    if (claim.documentVerification === 'CONFLICTED') {
      return {
        ok: false,
        reason: `claim ${id} lives in a CONFLICTED document (${claim.documentTitle}) and cannot support a factual assertion`,
        claim,
      };
    }
    const overlap = contentOverlap(assertion, `${claim.text} ${claim.quote}`);
    if (overlap < 0.12) {
      return {
        ok: false,
        reason: `claim ${id} does not appear to support the assertion (token overlap ${overlap.toFixed(2)})`,
        claim,
      };
    }
    return { ok: true, reason: 'supported', claim };
  }

  /**
   * Decide what a block of narration is, epistemically.
   *
   * Deliberately conservative: prose that mentions money, law, deadlines,
   * documents or officials is treated as a real-world claim unless it cites a
   * source. That means the default answer to "is this fact?" is "no, and you
   * have not shown me otherwise".
   */
  classifyNarration(text: string, citedIds: string[]): {
    grounding: Grounding;
    reason: string;
    validCitations: string[];
    invalidCitations: string[];
  } {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const id of citedIds) {
      const check = this.validateCitation(id, text);
      if (check.ok) valid.push(id);
      else invalid.push(id);
    }

    const claimsAssertion = looksLikeRealWorldClaim(text);

    if (valid.length > 0) {
      const anyInferred = valid.some((id) => this.getClaim(id)?.grounding === 'INFERRED');
      const anyVerified = valid.some((id) => this.getClaim(id)?.grounding === 'VERIFIED');
      if (anyVerified && !anyInferred) return { grounding: 'VERIFIED', reason: 'cited verified sources', validCitations: valid, invalidCitations: invalid };
      return { grounding: 'INFERRED', reason: 'cited sources include at least one inference', validCitations: valid, invalidCitations: invalid };
    }

    if (claimsAssertion) {
      return {
        grounding: 'UNKNOWN',
        reason: invalid.length > 0
          ? `makes a real-world assertion but the only citations offered (${invalid.join(', ')}) do not support it`
          : 'makes a real-world assertion with no supporting citation',
        validCitations: valid,
        invalidCitations: invalid,
      };
    }

    return {
      grounding: 'FICTIONAL_GAME_EVENT',
      reason: 'narrative beat about the fictional scenario, not a claim about Kenya',
      validCitations: valid,
      invalidCitations: invalid,
    };
  }

  /**
   * Detect topics the player asked about that the base genuinely cannot answer.
   * A gap is a first-class result, not a failure.
   */
  private findGaps(query: string, hits: RetrievedClaim[], raw: RetrievedClaim[]): GapReport[] {
    const gaps: GapReport[] = [];
    const terms = [...new Set(tokenize(query))].filter((t) => t.length > 2);
    if (terms.length === 0) return gaps;

    for (const term of terms.slice(0, 8)) {
      const matching = raw.filter((r) => r.matchedTerms.includes(term));
      if (matching.length === 0) continue; // not a topic the base addresses at all
      const usableMatch = matching.some((m) => this.isUsable(m.claim));
      if (usableMatch) continue;

      const unknowns = matching.filter((m) => m.claim.grounding === 'UNKNOWN');
      if (unknowns.length > 0) {
        for (const u of unknowns.slice(0, 2)) {
          gaps.push({
            topic: term,
            reason: `evidence exists but is UNKNOWN: ${u.claim.unknownReason || u.claim.text}`,
            attempted: [u.claim.id, u.claim.documentTitle],
          });
        }
      } else {
        gaps.push({
          topic: term,
          reason:
            'the knowledge base holds only conflicted secondary material on this point, which cannot be cited as fact',
          attempted: matching.map((m) => m.claim.id),
        });
      }
    }

    // Topical relevance is not the same as answerability.
    //
    // Asking "how much is the prescribed fee" retrieves plenty of relevant,
    // citable material: the Act says a prescribed fee is payable, and says the
    // amount lives in rules. Every one of those claims is VERIFIED. None of
    // them answers the question, which was a number.
    //
    // Without this check the player would be handed a confident, well-cited,
    // completely unanswering reply. That failure mode - a citation-shaped
    // non-answer - is more insidious than an obvious gap, so it gets its own
    // detection.
    const quantityAsk = QUANTITY_ASK.exec(query);
    if (quantityAsk) {
      const wantsMoney = /money|ksh|shilling|cost|fee|charge|price|pesa|pay|amount|figure/i.test(query);
      // Only citable claims can answer the question. A page of UNKNOWN claims
      // full of contradictory figures must not count as an answer - that is
      // precisely the situation this check exists to surface.
      //
      // Money and durations are counted separately too: a page of evidence
      // about "within seven days" contains quantities, and treating that as
      // evidence that a *fee figure* is available would silence the exact gap
      // this whole project is built around.
      const answerable = hits.filter((h) => this.isUsable(h.claim));
      const anyMoney = answerable.some((h) => extractMoney(h.claim.text).length > 0);
      const anyDuration = answerable.some((h) => extractDurations(h.claim.text).length > 0);
      const answered = wantsMoney ? anyMoney : anyDuration;
      if (!answered) {
        const amountUnknown = this.kb.claims.find(
          (c) =>
            c.grounding === 'UNKNOWN' &&
            (wantsMoney
              ? /amount|fee|cost|charge/i.test(c.text)
              : /how long|turnaround|processing time|days/i.test(c.text)),
        );
        gaps.push({
          topic: quantityAsk[0].trim().toLowerCase(),
          reason:
            `UNKNOWN: the sources retrieved are on topic but none states a ${wantsMoney ? 'figure' : 'time'}. ` +
            (amountUnknown
              ? (amountUnknown.unknownReason || amountUnknown.text)
              : `Answering would need a source this knowledge base does not contain.`),
          attempted: hits.map((h) => h.claim.id).slice(0, 5),
        });
      }
    }

    // De-duplicate by reason.
    const seen = new Set<string>();
    return gaps.filter((g) => {
      const key = `${g.topic}|${g.reason.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

/** Phrasings that ask for a number rather than a concept. */
const QUANTITY_ASK = /\b(how much|how many|how long|what (?:amount|number|figure|day|days)|cost|price|fee)\b/i;

function stripClaimIds(text: string): string {
  return text.replace(/C-[A-Z]+-\d+/g, ' ');
}

/** Monetary quantities: "KSh 950", "950 shillings". */
function extractMoney(text: string): number[] {
  const out: number[] = [];
  for (const m of stripClaimIds(text).matchAll(
    /\bksh\.?\s*([\d][\d,]*)|([\d][\d,]*)\s*(?:shillings|pesa|bob)\b/gi,
  )) {
    const value = Number.parseInt((m[1] ?? m[2] ?? '').replace(/,/g, ''), 10);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** Durations in days: "seven days", "twenty-eight days", "28 days". */
function extractDurations(text: string): number[] {
  const out: number[] = [];
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, twenty: 20,
    'twenty-eight': 28, twentyeight: 28, thirty: 30,
  };
  for (const m of stripClaimIds(text).toLowerCase().matchAll(
    /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|twenty-eight|twentyeight|thirty)[\s-]*days?\b/g,
  )) {
    const raw = m[1]!;
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : words[raw];
    if (value !== undefined && Number.isFinite(value)) out.push(value);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Heuristics                                                                  */
/* -------------------------------------------------------------------------- */

/** Every claim id in the knowledge base must look like `C-PREFIX-01`. */
export const CLAIM_ID_PATTERN = /^C-[A-Z]+-\d+$/;

/**
 * Markers that a passage has explicitly disclaimed as fiction.
 * Sentences containing one of these are removed before the masquerade check
 * runs, so that "the counter quotes KSh 1,000 - a figure invented for this
 * game" is correctly treated as declared simulation rather than as a
 * fabricated fact about Kenya.
 */
const DISCLAIMERS = [
  '[simulation]',
  'simulated',
  'in this game',
  'invented for this game',
  'in the fiction',
  'part of the fiction',
  'not a real',
  'game parameter',
  'the simulation',
  'simulation value',
];

/** Remove disclaimed sentences, leaving only the un-disclaimed remainder. */
export function stripDisclaimed(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const lower = sentence.toLowerCase();
      return !DISCLAIMERS.some((marker) => lower.includes(marker));
    })
    .join(' ');
}

/**
 * Does this passage, read as the player reads it, assert something about the
 * real world?
 *
 * This is the narrow question the Critic needs answered. "Does the text mention
 * a number or the word fee?" is the wrong question - half the game legitimately
 * does. The right question is whether it tells the player that a real
 * institution requires, permits, forbids or charges something specific.
 */
export function looksLikeInventedRequirement(text: string): boolean {
  const t = stripQuotations(stripDisclaimed(text)).toLowerCase();
  if (t.trim() === '') return false;

  const prescriptions: RegExp[] = [
    /\byou must\b/,
    /\byou are required\b/,
    /\byou have to\b/,
    /\bit is (?:illegal|required|mandatory|not allowed|prohibited)\b/,
    /\bthe law (?:says|requires|prohibits|allows)\b/,
    /\bthe act (?:says|requires|prohibits)\b/,
    /\brequired by (?:the )?(?:act|section|regulation|registrar|law)\b/,
    /\bthe registrar (?:will|must|requires|refuses)\b/,
    /\bthe government (?:requires|must|charges)\b/,
    /\bnairobi county (?:requires|charges|will)\b/,
    /\b(?:fee|cost|charge)s? (?:is|are|of|=|:)\s*ksh\s*\d/i,
    /\bksh\s*[\d,]+[a-z ]{0,20}\b(?:is required|is payable|is charged)\b/i,
    /\byou will be fined\b/,
    /\bis an offence to\b/,
  ];
  return prescriptions.some((p) => p.test(t));
}

/**
 * Remove quoted spans before testing for factual assertions.
 *
 * A Game Master that says: You say: "buy a trolley for KSh 5,000" is echoing
 * the player, not asserting that a trolley costs KSh 5,000. Without this, the
 * Critic fires on every echo and its signal drowns in false positives - which
 * is how an evaluation instrument becomes decorative.
 */
export function stripQuotations(text: string): string {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

/** Factual-assertion detector. Conservative by design. */
export function looksLikeRealWorldClaim(text: string): boolean {
  // Claim ids such as `C-FEE-04` contain both a topic word and digits. Leaving
  // them in makes any sentence referencing an unknown claim look like a
  // factual assertion about fees, which is exactly the wrong conclusion.
  const t = stripQuotations(text.replace(/C-[A-Z]+-\d+/g, ' ')).toLowerCase();
  const patterns: RegExp[] = [
    /\bksh\s*[\d,]/,
    /\b\d{2,}\s*(?:shillings|pesa|bob)\b/,
    /\b(?:the )?(?:act|statute|regulation|rule|section|clause|prescribed|mandate[ds]?)\b/,
    /\b(?:registrar|government|county|business registration service|brs|ecitizen|kra)\b/,
    /\b(?:required|required by|must|shall|obliged|obligated|prohibited|permitted|illegal|it is (?:illegal|required))\b/,
    /\b(?:fee|fees|cost|charge|charges|deadline|within \d+ days?|takes \d+|costs?)\b/,
    /\b(?:certificate|permit|licence|license)\b/,
    /\bin kenya\b/,
  ];
  return patterns.some((p) => p.test(t));
}

/** Jaccard-ish overlap between two strings, token set based. */
export function contentOverlap(a: string, b: string): number {
  const sa = new Set(tokenize(a).filter((t) => t.length > 2));
  const sb = new Set(tokenize(b).filter((t) => t.length > 2));
  if (sa.size === 0 || sb.size === 0) return 0;
  let hits = 0;
  for (const t of sa) if (sb.has(t)) hits += 1;
  return hits / Math.min(sa.size, sb.size);
}

