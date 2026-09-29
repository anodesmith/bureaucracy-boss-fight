/**
 * Lexical retrieval over the knowledge base.
 *
 * Deliberately boring: BM25 over claim text, topics, and quotes. No embeddings,
 * no vector store, no network. Reasons:
 *   - it runs offline, so the demo is genuinely zero-dependency;
 *   - it is fully inspectable, which is what Lab Mode needs;
 *   - an approximate retriever is the *safe* failure mode here. A better
 *     retriever could only ever find more of the same verified claims, never
 *     invent new ones, so there is no accuracy argument for the added opacity.
 */

import type { EvidenceClaim, RetrievedClaim } from '../../core/types.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on',
  'at', 'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'if', 'it', 'its', 'this', 'that',
  'i', 'you', 'me', 'my', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall',
  'there', 'here', 'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'not', 'no',
  'so', 'than', 'then', 'too', 'very', 'just', 'also', 'any', 'all', 'some', 'have', 'has', 'had',
]);

/** Normalisation of the vocabulary that actually matters in this domain. */
const NORMALISE: Record<string, string[]> = {
  cost: ['fee', 'fees', 'charge', 'charges', 'price', 'tariff', 'ksh', 'shilling', 'shillings'],
  fees: ['fee', 'charge', 'cost', 'price', 'ksh'],
  fee: ['fees', 'charge', 'cost', 'price', 'ksh'],
  pay: ['payment', 'pay', 'fees', 'mpesa', 'charge'],
  payment: ['pay', 'fees', 'mpesa', 'card', 'bank'],
  register: ['registration', 'registrar', 'b rs', 'brs', 'register'],
  registration: ['register', 'registrar', 'brs'],
  brs: ['business-registration-service', 'registrar', 'register'],
  name: ['names', 'business-name', 'name-search', 'reservation'],
  deadline: ['days', 'twenty-eight', '28', 'within', 'time'],
  certificate: ['certificates', 'display', 'exhibit', 'conspicuous'],
  display: ['exhibit', 'conspicuous', 'certificate', 'wall'],
  ksh: ['shilling', 'shillings', 'kes', 'cost', 'fees'],
  permit: ['licence', 'license', 'county', 'permission'],
  ecitizen: ['e-citizen', 'portal'],
  twentyeight: ['28', 'twenty-eight', 'days'],
  seven: ['7'],
  twentyeightdays: ['28', 'days'],
  own: ['name', 'surname', 'business'],
  surname: ['own', 'name', 'business'],
  trade: ['business', 'carrying', 'commerce'],
  trading: ['trade', 'business', 'commencing'],
  hang: ['display', 'exhibit', 'certificate'],
  hung: ['display', 'exhibit', 'certificate'],
  wall: ['display', 'exhibit', 'conspicuous'],
  show: ['display', 'exhibit', 'certificate'],
  counter: ['office', 'registrar', 'clerks'],
  queue: ['office', 'counter', 'wait'],
  sell: ['trade', 'business', 'customer'],
  selling: ['trade', 'business', 'customer'],
  customers: ['customer', 'trade', 'business'],
  food: ['business', 'cooking', 'stock'],
  stall: ['market', 'business', 'counter'],
  pin: ['pinn', 'tax', 'kra'],
  kra: ['kra', 'pin', 'tax', 'pinn'],
  account: ['ecitizen', 'registration', 'signup', 'sign'],
};

export function tokenize(input: string): string[] {
  const base = input
    .toLowerCase()
    .replace(/twenty[- ]?eight/g, ' twentyeight ')
    .replace(/(\d)[\d,\s]*\bksh/gi, ' ksh ')
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1 && t.length < 30);

  const out: string[] = [];
  for (const token of base) {
    if (STOPWORDS.has(token)) continue;
    out.push(token);
    // Cheap suffix folding so "registering"/"registered" hit "register".
    const folded = token.replace(/(ing|ed|es|s)$/i, '');
    if (folded.length > 2 && folded !== token) out.push(folded);
  }
  return out;
}

function expand(tokens: string[]): Set<string> {
  const set = new Set<string>(tokens);
  for (const token of tokens) {
    for (const extra of NORMALISE[token] ?? []) {
      set.add(extra);
    }
  }
  return set;
}

interface Indexed {
  claim: EvidenceClaim;
  /** Term -> term frequency. */
  tf: Map<string, number>;
  length: number;
}

export class Retriever {
  private readonly docs: Indexed[];
  private readonly avgLength: number;
  private readonly df = new Map<string, number>();

  constructor(claims: EvidenceClaim[]) {
    this.docs = claims.map((claim) => {
      const body = [
        claim.text,
        // Topics and the locator are curated metadata, so they carry extra weight.
        claim.topics.join(' '),
        claim.topics.join(' '),
        claim.topics.join(' '),
        claim.locator,
        claim.quote,
        claim.documentTitle,
        claim.grounding === 'UNKNOWN' ? `unknown ${claim.unknownReason}` : '',
      ].join(' ');
      const tokens = tokenize(body);
      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [term] of tf) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      return { claim, tf, length: tokens.length };
    });
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length === 0 ? 1 : Math.max(1, total / this.docs.length);
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** BM25. `boostGrounding` lets callers prefer VERIFIED material. */
  search(query: string, limit = 8, boostGrounding = true): RetrievedClaim[] {
    const queryTerms = expand(tokenize(query));
    if (queryTerms.size === 0) return [];

    const k1 = 1.4;
    const b = 0.72;
    const results: RetrievedClaim[] = [];

    for (const doc of this.docs) {
      let score = 0;
      const matched: string[] = [];
      for (const term of queryTerms) {
        const freq = doc.tf.get(term);
        if (!freq) continue;
        const idf = this.idf(term);
        if (idf <= 0) continue;
        const denom = freq + k1 * (1 - b + (b * doc.length) / this.avgLength);
        score += idf * ((freq * (k1 + 1)) / denom);
        matched.push(term);
      }
      if (score <= 0) continue;

      if (boostGrounding) {
        // Prefer primary material and verified material, but do not let the
        // boost create a hit where retrieval found nothing.
        const g = doc.claim.grounding;
        if (g === 'VERIFIED' && doc.claim.documentVerification === 'VERIFIED') score *= 1.35;
        if (g === 'UNKNOWN') score *= 0.85;
      }

      results.push({
        claim: doc.claim,
        score: Number(score.toFixed(4)),
        matchedTerms: [...new Set(matched)].slice(0, 8),
      });
    }

    results.sort((a, b) => b.score - a.score || a.claim.id.localeCompare(b.claim.id));
    return results.slice(0, limit);
  }

  /** Claims tagged with a topic, regardless of query. */
  byTopic(topic: string): EvidenceClaim[] {
    const needle = topic.toLowerCase();
    return this.docs
      .filter((d) => d.claim.topics.includes(needle))
      .map((d) => d.claim);
  }
}
