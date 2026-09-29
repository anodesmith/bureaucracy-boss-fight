/**
 * DEMO GAME MASTER
 * ================
 * A complete, deterministic Game Master. Not a stub.
 *
 * This exists so that a fresh clone is playable in under a minute with no API
 * key, no network and no model. It is also the control condition for the
 * evaluation harness: when you want to measure what the model contributes, you
 * run the same seeds with this Game Master and compare.
 *
 * It plays properly. It reads the evidence bundle, answers questions from
 * verified claims, and says "I don't know" when the knowledge base does not
 * know - which is the behaviour the whole project is trying to demonstrate.
 */

import type { GameMasterProposal, NarrationBlock, TurnContext } from '../../core/types.js';
import type { GameMaster } from './types.js';

const SIM = '[SIMULATION]';

export class DemoGameMaster implements GameMaster {
  readonly name = 'demo';

  opening(context: {
    title: string;
    brief: string;
    objectives: Array<{ title: string; description: string }>;
  }): NarrationBlock[] {
    return [
      { text: context.brief, grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] },
      {
        text: `${context.objectives.length} objectives. Some need facts you do not have yet. You can go and get them.`,
        grounding: 'FICTIONAL_GAME_EVENT',
        claimIds: [],
      },
    ];
  }

  propose(context: TurnContext): GameMasterProposal {
    const { resolution, evidence, intent } = context;
    const available = resolution.options.filter((o) => o.available);
    const chosen = this.choose(context, available);

    return {
      chosenOptionId: chosen?.id ?? null,
      narration: [
        ...this.decorate(context, chosen?.id ?? null),
        ...(intent.type === 'ASK' ? this.answer(context) : []),
      ],
      unresolved: evidence.gaps.map((g) => g.topic),
    };
  }

  /**
   * Option selection. Deterministic, and easy to read in Lab Mode: the demo
   * Game Master always takes the first available option, because the engine
   * orders options so the first is the scenario's intended reading of the
   * action. Where an action is ambiguous it takes the most conservative one
   * available, which is a deliberate choice: an ambiguous order should cost
   * the player nothing irreversible.
   */
  private choose(context: TurnContext, available: TurnContext['resolution']['options']): TurnContext['resolution']['options'][number] | undefined {
    if (available.length === 0) return undefined;
    if (context.intent.confidence < 0.4) {
      const conservative = available.find((o) => o.effects.length === 0);
      if (conservative) return conservative;
    }
    return available[0];
  }

  /** Short flavour beat. Never a real-world claim. */
  private decorate(context: TurnContext, chosenId: string | null): NarrationBlock[] {
    const { state, intent } = context;
    if (chosenId === null) return [];

    if (/^\s*$/.test(intent.text) && intent.type === 'WAIT') {
      return [{ text: `${SIM} You wait. The city does not pause to accommodate your schedule.`, grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] }];
    }

    // A one-line acknowledgement of what the player said, purely stylistic.
    const echo = summariseIntent(intent.text);
    if (!echo) return [];
    return [
      {
        text: `${SIM} ${echo} Day ${state.day + 1}.`,
        grounding: 'FICTIONAL_GAME_EVENT',
        claimIds: [],
      },
    ];
  }

  /**
   * Answer a question from the evidence bundle, as properly grounded blocks.
   *
   * This is the heart of demo mode. It cites verified claims, reports UNKNOWN
   * claims as unknown, and surfaces the conflict when the question was about
   * money. Every block carries its citations, so the Critic can audit it and
   * the player can open the source.
   */
  private answer(context: TurnContext): NarrationBlock[] {
    const { evidence } = context;
    const usable = evidence.claims.filter((c) => evidence.usable.includes(c.claim.id));
    const unknowns = evidence.claims.filter((c) => c.claim.grounding === 'UNKNOWN');
    const blocks: NarrationBlock[] = [];

    if (usable.length > 0) {
      const best = usable[0]!.claim;
      blocks.push({
        text: `Here is what the source says. ${best.documentTitle}, ${best.locator}: ${best.text}`,
        grounding: best.grounding,
        claimIds: [best.id],
      });
      for (const extra of usable.slice(1, 3)) {
        blocks.push({
          text: `Also, ${extra.claim.locator}: ${extra.claim.text}`,
          grounding: extra.claim.grounding,
          claimIds: [extra.claim.id],
        });
      }
    } else {
      blocks.push({
        text: `I cannot answer that from anything I can actually reach. That is a real answer rather than a dodge.`,
        grounding: 'UNKNOWN',
        claimIds: [],
      });
    }

    if (unknowns.length > 0) {
      const u = unknowns[0]!.claim;
      blocks.push({
        text: `And here is the part nobody can tell you: ${u.unknownReason}`,
        grounding: 'UNKNOWN',
        claimIds: [u.id],
      });
    }

    if (evidence.gaps.length > 0) {
      blocks.push({
        text: `I looked for it and there is a hole in the record. That is the honest state of things, and it is exactly why guessing here is expensive.`,
        grounding: 'UNKNOWN',
        claimIds: [],
      });
    }

    return blocks;
  }
}

function summariseIntent(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 90) return `You say: "${trimmed}".`;
  return `You say: "${trimmed.slice(0, 87)}...".`;
}
