/**
 * LLM-backed Game Master.
 *
 * The prompt's job is to make one thing easy and one thing impossible:
 *
 *   EASY   - writing a good sentence about what just happened.
 *   IMPOSSIBLE - producing a fee, a deadline, or a state change, because none of
 *               those are things it is asked for, and the ones it does get to
 *               influence are options the engine already computed.
 *
 * The model is told the four grounding categories and is asked to return JSON.
 * We do not ask it for its reasoning. We ask for a decision and a label. The
 * Critic audits the label. `docs/architecture.md` explains why asking for
 * reasoning here would make the system worse, not better.
 */

import type {
  GameMasterProposal,
  NarrationBlock,
  TurnContext,
  Grounding,
} from '../../core/types.js';
import type { GameMaster } from './types.js';
import type { LLMProvider } from '../../providers/types.js';
import { extractJson } from '../../providers/types.js';
import { looksLikeRealWorldClaim } from '../evidence/index.js';

const GROUNDINGS: Grounding[] = ['VERIFIED', 'INFERRED', 'UNKNOWN', 'FICTIONAL_GAME_EVENT'];

const SYSTEM_PROMPT = `You are the Game Master of a grounded simulation game set in Kenya. You run the world. You are not a chatbot and you are not a lawyer.

THE FOUR GROUNDING CATEGORIES. Every block of prose you emit must be labelled with exactly one:

- VERIFIED: directly supported by a source the Evidence Agent gave you. You MUST list the claim ids that support it. If you cannot list real ids, you may not use this label.
- INFERRED: a reasonable conclusion drawn from sources, but not itself stated in them. List the claim ids you drew from.
- UNKNOWN: the evidence does not answer this. Say so plainly. Never guess.
- FICTIONAL_GAME_EVENT: narration about the invented scenario. Prices, weather, queues, customers, your character's feelings. This is the default for scene-setting.

THE ONE RULE THAT MATTERS MOST
The amount of the official registration fee is NOT KNOWN. Sources disagree with each other. If you state a fee, it must be labelled FICTIONAL_GAME_EVENT and must be the simulated number the engine already gave you in the option you chose. You may never present a fee as a real Kenyan figure, and you may never invent one that is not in the option text.

WHAT YOU ARE GIVEN
- A list of options the engine has already computed as legal this turn. Exactly one of them happens. Choose one.
- Retrieved evidence with claim ids, grounding labels, and quotes.
- Gaps: topics the knowledge base genuinely cannot answer.

WHAT YOU ARE NOT ASKED FOR
- You are NOT asked to set prices, fees, deadlines, or any other number. You cannot, and you should not try. Every number already exists in the option you select.
- You are NOT asked for your reasoning. Do not include it. Return a short "decision_summary" instead, which is a description of the choice, not a justification chain.

OUTPUT. Return a single JSON object and nothing else:

{
  "chosen_option_id": "<id from options>",
  "decision_summary": "<one sentence, max 25 words, describing the choice, not justifying it>",
  "unresolved": ["<topics you could not answer, from the gaps list>"],
  "narration": [
    { "text": "<one or two sentences>", "grounding": "<one of the four>", "claim_ids": ["C-XXX-00"] }
  ]
}

Rules for narration:
- This is the ONLY place your words reach the player. There is no other field they will see. If the player asked a question, your answer goes in here, as one or more blocks.
- At most three entries.
- "VERIFIED" entries must cite at least one real claim id from the evidence list. An id you invent will be rejected by the Critic and the turn will be marked down.
- If you want to mention a real-world fact and you have no id for it, use "UNKNOWN" and say what is missing. That is the correct answer, not a failure.
- Keep the voice dry, specific and unsentimental. Nairobi is not a stereotype. Money is a constraint, not a plot point.`;

export interface LLMGameMasterOptions {
  provider: LLMProvider;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export class LLMGameMaster implements GameMaster {
  readonly name: string;
  private readonly provider: LLMProvider;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(options: LLMGameMasterOptions) {
    this.provider = options.provider;
    this.name = `llm(${this.provider.name})`;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 600;
    this.timeoutMs = options.timeoutMs ?? 45000;
  }

  opening(context: { title: string; brief: string; objectives: Array<{ title: string; description: string }> }): NarrationBlock[] {
    return [{ text: context.brief, grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] }];
  }

  async propose(context: TurnContext): Promise<GameMasterProposal> {
    const userPrompt = buildUserPrompt(context);
    let parsed: unknown;
    try {
      const response = await this.provider.chat({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
      });
      parsed = extractJson(response.text);
    } catch {
      return this.fallback(context);
    }

    return this.normalise(context, parsed);
  }

  private fallback(context: TurnContext): GameMasterProposal {
    const available = context.resolution.options.filter((o) => o.available);
    return {
      chosenOptionId: available[0]?.id ?? null,
      narration: [],
      unresolved: context.evidence.gaps.map((g) => g.topic),
    };
  }

  /**
   * Validate the model's output against the engine's contract.
   *
   * Every field is checked. An unknown option id, a malformed grounding label,
   * an invented claim id, or a VERIFIED block with no citations all degrade the
   * result rather than being trusted.
   */
  private normalise(context: TurnContext, parsed: unknown): GameMasterProposal {
    const availableIds = new Set(
      context.resolution.options.filter((o) => o.available).map((o) => o.id),
    );
    const knownClaimIds = new Set(context.evidence.claims.map((c) => c.claim.id));

    if (typeof parsed !== 'object' || parsed === null) return this.fallback(context);
    const raw = parsed as Record<string, unknown>;

    const chosenId =
      typeof raw['chosen_option_id'] === 'string' && availableIds.has(raw['chosen_option_id'])
        ? (raw['chosen_option_id'] as string)
        : (context.resolution.options.filter((o) => o.available)[0]?.id ?? null);

    const narration: NarrationBlock[] = [];
    if (Array.isArray(raw['narration'])) {
      for (const entry of raw['narration'].slice(0, 3)) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const text = typeof e['text'] === 'string' ? (e['text'] as string).trim() : '';
        if (text === '') continue;

        const claimed = GROUNDINGS.includes(e['grounding'] as Grounding)
          ? (e['grounding'] as Grounding)
          : 'UNKNOWN';
        const claimIds = Array.isArray(e['claim_ids'])
          ? (e['claim_ids'] as unknown[]).filter(
              (id): id is string => typeof id === 'string' && knownClaimIds.has(id),
            )
          : [];

        // The one non-negotiable: real-world assertion with no real citation
        // cannot be labelled VERIFIED, whatever the model said.
        let grounding = claimed;
        if (grounding === 'VERIFIED' && claimIds.length === 0) {
          grounding = looksLikeRealWorldClaim(text) ? 'UNKNOWN' : 'FICTIONAL_GAME_EVENT';
        }
        if (grounding === 'VERIFIED') {
          const anyVerified = claimIds.some(
            (id) => context.evidence.claims.find((c) => c.claim.id === id)?.claim.grounding === 'VERIFIED',
          );
          if (!anyVerified) grounding = 'INFERRED';
        }

        narration.push({ text, grounding, claimIds });
      }
    }

    const unresolved = Array.isArray(raw['unresolved'])
      ? (raw['unresolved'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : context.evidence.gaps.map((g) => g.topic);

    return {
      chosenOptionId: chosenId,
      narration,
      unresolved: unresolved.slice(0, 6),
    };
  }
}

function buildUserPrompt(context: TurnContext): string {
  const { state, intent, resolution, evidence } = context;
  const usable = new Set(evidence.usable);

  const lines: string[] = [];
  lines.push(`MISSION: ${context.scenarioTitle}`);
  lines.push(`PLAYER: ${context.playerProfile}`);
  lines.push('');
  lines.push(`TURN ${state.turn + 1} of ${state.maxTurns}. In-world day ${state.day}. Money: KSh ${state.money}.`);
  lines.push(`Player said: "${intent.text}"`);
  lines.push(`Parsed as: ${intent.type} (confidence ${intent.confidence.toFixed(2)})`);
  lines.push('');

  lines.push('OPTIONS (choose exactly one id):');
  for (const option of resolution.options) {
    lines.push(
      option.available
        ? `- id="${option.id}": ${option.summary}`
        : `- id="${option.id}": UNAVAILABLE - ${option.unavailableReason}`,
    );
  }
  lines.push('');

  lines.push('EVIDENCE (you may cite only these ids):');
  if (evidence.claims.length === 0) {
    lines.push('- (nothing retrieved)');
  }
  for (const hit of evidence.claims) {
    const c = hit.claim;
    const flag = usable.has(c.id) ? 'USABLE' : 'NOT USABLE';
    lines.push(
      `- [${c.id}] (${c.grounding}, ${flag}, score ${hit.score}) ${c.documentTitle} ${c.locator}: ${c.text}`,
    );
    if (c.quote) lines.push(`    quote: ${c.quote.slice(0, 220)}`);
  }
  lines.push('');

  lines.push('GAPS (things the record genuinely does not answer):');
  if (evidence.gaps.length === 0) lines.push('- (none)');
  for (const gap of evidence.gaps) {
    lines.push(`- ${gap.topic}: ${gap.reason}`);
  }
  lines.push('');

  lines.push('KNOWN TO THE PLAYER SO FAR:');
  lines.push(
    state.revealedClaims.length > 0
      ? state.revealedClaims.join(', ')
      : '(nothing - the player has not read anything yet)',
  );
  lines.push('');
  lines.push('Return the JSON object described in your instructions.');

  return lines.join('\n');
}
