/**
 * MISSION 001 - "Umoja wa Wananchi Food Point"
 * Start a small food business in Nairobi with KSh 8,000.
 *
 * Design rules this scenario obeys:
 *
 * 1. Every real-world statement is backed by a claim in `knowledge/`. The
 *    statutory scaffolding of this mission is real, quotable Kenyan law.
 * 2. Every number that is NOT in `knowledge/` is a simulation parameter and is
 *    labelled as such in the narration the player sees. Prices, the fee the
 *    counter quotes, the weather, the customer's mood: all fiction, all marked.
 * 3. The one genuinely important UNKNOWN - the amount of the prescribed fee -
 *    is load-bearing. You can play the mission without ever learning it, and
 *    the game will let you succeed, but you will have to have budgeted for it
 *    blind. That is the point.
 */

import type {
  ActionIntent,
  Effect,
  EffectOption,
  Ending,
  GameState,
  GameEvent,
  NarrationBlock,
  ObjectiveState,
} from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import { option, type AmbientEvent, type Rule, type RuleContext, type ScenarioDefinition } from './types.js';

/* -------------------------------------------------------------------------- */
/* SIMULATION PARAMETERS                                                       */
/* -------------------------------------------------------------------------- */
/*
 * None of the figures below are claims about Kenya. They are the game's
 * economy. They are chosen to be *plausible* so the arithmetic is interesting,
 * and they are surfaced to the player as [SIMULATED] so nobody mistakes them
 * for a published fee. If you edit these, edit the note in `docs/design.md`.
 */
const SIM = {
  startingMoney: 8000,
  trolley: 5000,
  gasStove: 2200,
  firstStock: 1200,
  /** The "prescribed fee" the fictional counter quotes. NOT a real fee. */
  prescribedFee: 1000,
  accountFee: 0,
  /** Daily cost of actually trading (stock + charcoal). */
  tradingBurn: 150,
  matatuFare: 50,
  marketStallPitchFee: 300,
  repairKit: 400,
} as const;

const MAX_TURNS = 14;
const START_DAY = 1;
const CALENDAR_EPOCH = 'Day 1 = the first of the month';

const money = (n: number): string => `KSh ${n.toLocaleString('en-KE')}`;

/* -------------------------------------------------------------------------- */
/* Objectives                                                                  */
/* -------------------------------------------------------------------------- */

const OBJECTIVES: ObjectiveState[] = [
  {
    id: 'o-survey',
    title: 'Find out what the rules actually are',
    description:
      'Establish, from sources, who registers what and what the deadlines are. Guessing is not finding out.',
    status: 'ACTIVE',
    kind: 'EVIDENCE',
    requiresClaims: [],
    completeWhenClaimsKnown: ['C-RBN-01', 'C-RBN-03', 'C-RBN-06'],
    optional: false,
  },
  {
    id: 'o-fee',
    title: 'Establish the cost of registration',
    description:
      'Learn what the prescribed fee actually is, or prove to yourself that it is not knowable from the sources at hand.',
    status: 'ACTIVE',
    kind: 'EVIDENCE',
    requiresClaims: [],
    completeWhenClaimsKnown: ['C-RBN-17', 'C-BRS-10'],
    optional: false,
  },
  {
    id: 'o-name',
    title: 'Lodge the name search',
    description: 'Send the prescribed fee and a written request to the Registrar, at least seven days before you trade.',
    status: 'LOCKED',
    kind: 'ACTION',
    requiresClaims: ['C-RBN-06'],
    optional: false,
  },
  {
    id: 'o-register',
    title: 'Register the business name',
    description: 'Lodge the statement of particulars within twenty-eight days of starting to trade.',
    status: 'LOCKED',
    kind: 'ACTION',
    requiresClaims: ['C-RBN-03'],
    optional: false,
  },
  {
    id: 'o-display',
    title: 'Display the certificate',
    description: 'Hang the certificate where customers can see it. This is an offence to skip.',
    status: 'LOCKED',
    kind: 'ACTION',
    requiresClaims: ['C-RBN-05'],
    optional: false,
  },
  {
    id: 'o-trade',
    title: 'Serve your first customer',
    description: 'Actually cook something and sell it. Paperwork that never reaches a plate is a hobby.',
    status: 'LOCKED',
    kind: 'ACTION',
    requiresClaims: [],
    optional: false,
  },
  {
    id: 'o-solvent',
    title: 'Stay solvent',
    description: 'Finish the run with money in hand. Zero is a scoreboard, not a business.',
    status: 'ACTIVE',
    kind: 'ACTION',
    requiresClaims: [],
    optional: false,
  },
];

/* -------------------------------------------------------------------------- */
/* Endings                                                                     */
/* -------------------------------------------------------------------------- */

const ENDINGS: Ending[] = [
  {
    id: 'e-certified',
    title: 'Certified and Cooking',
    grade: 'S',
    blurb:
      'Registered, displayed, trading, solvent. You did the boring thing in the right order and the certificate is on the wall where the Act wants it.',
  },
  {
    id: 'e-registered',
    title: 'Registered and Running',
    grade: 'A',
    blurb:
      'The paperwork is done and the food is moving. Something you skipped will come back for you later, but the business is real.',
  },
  {
    id: 'e-trading',
    title: 'Trading, Technically',
    grade: 'B',
    blurb:
      'Plates are leaving the counter. The certificate is in a plastic bag in your rucksack, which is not the same as displayed.',
  },
  {
    id: 'e-own-name',
    title: 'Under Your Own Name',
    grade: 'C',
    blurb:
      'You read section 4, decided the registration trigger never fired, and traded under your own surname. Legal, perhaps. Lonely.',
  },
  {
    id: 'e-unregistered',
    title: 'Trading Without a Paperwork Shield',
    grade: 'D',
    blurb:
      'You are cooking and you are exposed. In this world that is a customer who asks for a receipt, and a worse world where it is a contract you cannot enforce.',
  },
  {
    id: 'e-broke',
    title: 'Broke at the Counter',
    grade: 'D',
    blurb: 'The money ran out. That is the most common ending and the least dramatic.',
  },
  {
    id: 'e-timeout',
    title: 'Still Waiting',
    grade: 'C',
    blurb: 'The turns ran out with the application somewhere in a queue. The queue wins more often than it should.',
  },
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const sim = (text: string): NarrationBlock => ({
  text: `[SIMULATION] ${text}`,
  grounding: 'FICTIONAL_GAME_EVENT',
  claimIds: [],
});

const day = (d: number): string => `day ${d}`;

/**
 * A turn that changes nothing still changes something: the calendar.
 * A no-op option that costs no day would let a player stall for free, which
 * would make the twenty-eight day deadline the only clock in the game and
 * therefore meaningless.
 */
const idle = (ruleId: string, days = 1): Effect => ({
  kind: 'DAY_ADVANCE',
  days,
  ruleId,
  reason: 'A day spent on an action the scenario does not model.',
});

/**
 * Complete any EVIDENCE objective whose claims the player now holds.
 *
 * Uses `every`, not `some`: an objective naming three claims is asking for
 * three things understood, and completing on one of them would make the
 * objective list decorative.
 *
 * Only EVIDENCE objectives are eligible. An ACTION objective is completed by
 * a rule emitting OBJECTIVE_COMPLETE, never by the player having read about it.
 */
const completeEvidenceObjectives = (
  ctx: RuleContext,
  newlyRevealed: string[],
  ruleId: string,
): Effect[] => {
  const known = new Set([...ctx.revealed(), ...newlyRevealed]);
  return ctx.state.objectives
    .filter(
      (o) =>
        o.kind === 'EVIDENCE' &&
        o.status !== 'COMPLETE' &&
        o.status !== 'FAILED' &&
        (o.completeWhenClaimsKnown ?? []).length > 0 &&
        (o.completeWhenClaimsKnown ?? []).every((id) => known.has(id)),
    )
    .map((o) => ({
      kind: 'OBJECTIVE_COMPLETE' as const,
      objectiveId: o.id,
      ruleId,
      reason: 'The player now holds every source this objective asked for.',
    }));
};

/**
 * Reveal at most `MAX_REVEALS` claims per action.
 *
 * Discovery should be paced. A single question that dumps twenty claims makes
 * the evidence drawer unreadable and lets one lucky query solve the mission.
 */
const MAX_REVEALS = 3;
const revealIf = (ctx: RuleContext, ...ids: string[]): Effect[] => {
  const alreadyKnown = ctx.revealed();
  const fresh = ids.filter((id) => ctx.kb.byClaimId.has(id) && !alreadyKnown.has(id));
  return fresh.slice(0, MAX_REVEALS).map((claimId) => ({
    kind: 'CLAIM_REVEAL' as const,
    claimId,
    ruleId: 'r-reveal',
    reason: 'The player read the source.',
  }));
};

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

const rSurvey: Rule = {
  id: 'r-survey',
  purpose: 'Player researches a topic. Reveal whatever the knowledge base actually supports and report gaps.',
  when: (ctx) => ctx.intent.type === 'RESEARCH',
  resolve: (ctx) => {
    const topic = ctx.intent.text;
    const found = ctx.evidence.claims.filter((c) => ctx.evidence.usable.includes(c.claim.id));
    const unknowns = ctx.evidence.claims.filter(
      (c) => c.claim.grounding === 'UNKNOWN' && c.claim.unknownReason.length > 0,
    );

    const narration: NarrationBlock[] = [];
    narration.push(
      sim(
        `You spend a morning reading. The sun is the colour of old brass and the road outside is loud in the way that makes a phone screen hard to read.`,
      ),
    );

    if (found.length > 0) {
      for (const hit of found.slice(0, 4)) {
        const c = hit.claim;
        narration.push({
          text: `${c.documentTitle} (${c.documentUrl}), ${c.locator}: ${c.text}`,
          grounding: c.grounding,
          claimIds: [c.id],
        });
      }
    } else {
      narration.push(
        sim(
          `You read for two hours and come away with the distinct feeling of having learned nothing. That is not a failure of the reading. It is what the evidence actually says.`,
        ),
      );
    }

    if (unknowns.length > 0) {
      const u = unknowns[0]!.claim;
      narration.push({
        text: `What nobody can tell you: ${u.unknownReason}`,
        grounding: 'UNKNOWN',
        claimIds: [u.id],
      });
    }

    narration.push(
      sim(`That is ${day(ctx.state.day + 1)} now. Reading is not free, but it is cheaper than the alternatives.`),
    );

    const revealed = found.map((f) => f.claim.id);
    const effects: Effect[] = [
      ...revealIf(ctx, ...revealed),
      ...completeEvidenceObjectives(ctx, revealed, rSurvey.id),
      { kind: 'DAY_ADVANCE', days: 1, ruleId: rSurvey.id, reason: 'A morning spent reading.' },
    ];

    const events: GameEvent[] =
      unknowns.length > 0
        ? [
            {
              id: 'gap-found',
              title: 'Gap in the record',
              body: unknowns[0]!.claim.unknownReason,
              kind: 'DISCOVERY',
              grounding: 'UNKNOWN',
              claimIds: [unknowns[0]!.claim.id],
              severity: 'warn',
            },
          ]
        : [];

    return [
      option('survey', `Reveal up to 4 supported claims about "${topic}". Costs one day.`, effects, narration, {
        events,
      }),
    ];
  },
};

const rAsk: Rule = {
  id: 'r-ask',
  purpose: 'Player asks a question. Answer from the knowledge base or admit the gap. Never improvise a fee.',
  when: (ctx) => ctx.intent.type === 'ASK',
  resolve: (ctx) => {
    const usable = ctx.evidence.claims.filter((c) => ctx.evidence.usable.includes(c.claim.id));
    const unknowns = ctx.evidence.claims.filter((c) => c.claim.grounding === 'UNKNOWN');
    const narration: NarrationBlock[] = [];

    if (usable.length > 0) {
      const best = usable[0]!.claim;
      narration.push({
        text: `Here is what the source actually says. ${best.documentTitle} (${best.documentUrl}), ${best.locator}: ${best.text}`,
        grounding: best.grounding,
        claimIds: [best.id],
      });
      for (const extra of usable.slice(1, 3)) {
        narration.push({
          text: `Also: ${extra.claim.text} (${extra.claim.locator})`,
          grounding: extra.claim.grounding,
          claimIds: [extra.claim.id],
        });
      }
    } else {
      narration.push(
        sim(
          `You ask around. The answers arrive in the shape everybody's answers take, which is a shape and not a number.`,
        ),
      );
    }

    if (unknowns.length > 0) {
      const u = unknowns[0]!.claim;
      narration.push({
        text: `The honest answer: this knowledge base cannot tell you. ${u.unknownReason}`,
        grounding: 'UNKNOWN',
        claimIds: [u.id],
      });
    }

    narration.push(sim(`Asking costs you half a day of daylight. ${day(ctx.state.day)} still holds.`));

    const usableIds = usable.map((u) => u.claim.id);
    const effects: Effect[] = [
      ...revealIf(ctx, ...usableIds),
      ...completeEvidenceObjectives(ctx, usableIds, rAsk.id),
      { kind: 'DAY_ADVANCE', days: 1, ruleId: rAsk.id, reason: 'Half a day spent chasing an answer.' },
    ];

    return [option('ask', 'Answer from the knowledge base, or report the gap.', effects, narration)];
  },
};

const rBuy: Rule = {
  id: 'r-buy',
  purpose: 'Player buys equipment or stock. Price comes from the SIM table, never from a model.',
  when: (ctx) => ctx.intent.type === 'BUY',
  resolve: (ctx) => {
    const item = String(ctx.intent.slots['item'] ?? '').trim();
    const amount = typeof ctx.intent.slots['amount'] === 'number' ? (ctx.intent.slots['amount'] as number) : 0;

    // A vague item is a legitimate refusal, not a silent guess.
    if (item.length === 0) {
      return [
        option(
          'buy-unclear',
          'Ask the player to name the item.',
          [idle('rBuy')],
          [
            sim(
              `You reach for your wallet and then realise you have not decided what for. Be specific: "buy a gas stove for ${money(SIM.gasStove)}".`,
            ),
          ],
        ),
      ];
    }

    const catalogue: Array<{ id: string; label: string; price: number; match: RegExp }> = [
      { id: 'trolley', label: 'Second-hand food trolley', price: SIM.trolley, match: /trolley|cart|table|wheel/i },
      { id: 'stove', label: 'Two-burner gas stove with a cylinder', price: SIM.gasStove, match: /stove|gas|burner|cooker|cooking|pot|cylinder|jiko/i },
      { id: 'stock', label: 'Opening stock: flour, onions, oil, tomatoes', price: SIM.firstStock, match: /stock|ingredient|flour|food|maize|onion|oil|tomato/i },
      { id: 'repair', label: 'Toolbox and spares for the trolley', price: SIM.repairKit, match: /repair|tool|spares|spanner/i },
    ];

    const match = catalogue.find((c) => c.match.test(item));
    if (!match) {
      return [
        option(
          'buy-unknown-item',
          'No catalogue entry matches; nothing is bought.',
          [idle('rBuy')],
          [
            sim(
              `You ask about a ${item}. The market does not stock it, or at least not the market you are standing in, and the money stays in your pocket.`,
            ),
          ],
        ),
      ];
    }

    // A stated amount is treated as a budget, not a price, and only the shortfall
    // or the balance is charged. Real shops do not round up to your optimism.
    const charged = amount > 0 ? Math.min(amount, match.price) : match.price;
    const refused = amount > 0 && amount < match.price;

    const narration: NarrationBlock[] = [
      sim(
        `You buy ${match.label.toLowerCase()} for ${money(charged)}. The seller counts it twice and nods, which is the part of Nairobi that works exactly as advertised.`,
      ),
    ];
    if (refused) {
      narration.push(
        sim(`You had ${money(amount)} in your head. It costs ${money(match.price)}. You hand over what you have and the balance is the seller's problem now, in the sense that you owe him.`),
      );
    }

    const effects: Effect[] = [
      { kind: 'MONEY_DELTA', delta: -charged, ruleId: rBuy.id, reason: `Purchased ${match.label}.`, grounding: 'FICTIONAL_GAME_EVENT' },
      {
        kind: 'ITEM_ADD',
        item: { id: match.id, label: match.label, quantity: 1, official: false, description: 'Bought in the fiction at a simulated price.' },
        ruleId: rBuy.id,
        reason: 'Added to inventory.',
        grounding: 'FICTIONAL_GAME_EVENT',
      },
      { kind: 'DAY_ADVANCE', days: 1, ruleId: rBuy.id, reason: 'A morning of haggling and carrying.' },
    ];

    return [option('buy', `Buy ${match.label} for ${money(match.price)} (simulation price).`, effects, narration)];
  },
};

const rApply: Rule = {
  id: 'r-apply',
  purpose: 'Player lodges a name search or a registration. Enforces the statutory sequencing.',
  when: (ctx) => ctx.intent.type === 'APPLY',
  resolve: (ctx) => {
    const wantsName = /\b(name|reservation|reserve|search|availability)\b/i.test(ctx.intent.text);
    const wantsRegister =
      /\b(register|registration|particulars|certificate|complete it|finalise|finalize)\b/i.test(
        ctx.intent.text,
      );
    const searchDone = ctx.state.flags['nameSearchLodged'] === 'yes';

    // "Register the business name" contains the word "name", so testing for a
    // name search first would send a player who has already searched straight
    // back to the counter. Once the search is on file, an explicit "register"
    // means registration.
    const wantsSearch = wantsName && !(wantsRegister && searchDone);

    const flagSearch = ctx.state.flags['nameSearchLodged'];
    const flagDecision = ctx.state.flags['nameDecision'];
    const tradingDay = Number(ctx.state.flags['tradingDay'] ?? 0);

    // --- Name search -----------------------------------------------------
    if (wantsSearch || (!wantsRegister && flagSearch !== 'yes')) {
      if (flagSearch === 'yes') {
        return [
          option(
            'name-already',
            'The name search is already lodged.',
            [idle('rApply')],
            [sim(`You have already lodged the request. The Registrar has seven days, and then whatever he has, he has.`)],
          ),
        ];
      }

      const narration: NarrationBlock[] = [];
      const effects: Effect[] = [];
      const events: GameEvent[] = [];

      narration.push(
        sim(`You compose the request: the name, a written ask whether it may be registered, and the prescribed fee. You do not know the prescribed fee. You go anyway, because not going guarantees the answer is no.`),
      );
      narration.push({
        text: `The statutory route: not less than seven days before you start trading, send the prescribed fee with a written request, and the Registrar must reply within seven days of receiving it (${'section 17(2)'}).`,
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-06'],
      });
      narration.push({
        text: `The amount of the prescribed fee is not stated in the Act; it is set by rules (${'section 22(a)'}). This knowledge base does not contain those rules.`,
        grounding: 'UNKNOWN',
        claimIds: ['C-RBN-17'],
      });

      // The simulated fee. The player pays it, but is told, loudly, that the
      // number is a simulation parameter and not a published figure.
      const fee = SIM.prescribedFee;
      narration.push(
        sim(`The counter quotes ${money(fee)} for the search and registration. That is a figure invented for this game. In the real system you would be quoting the prescribed fee, whose amount this knowledge base cannot supply.`),
      );

      const feeClaimIds = ['C-RBN-06', 'C-RBN-17', 'C-BRS-10'];
      effects.push(
        { kind: 'FLAG_SET', flag: 'nameSearchLodged', value: 'yes', ruleId: rApply.id, reason: 'Search request sent.' },
        { kind: 'FLAG_SET', flag: 'nameSearchDay', value: ctx.state.day, ruleId: rApply.id, reason: 'Day the request went out.' },
        { kind: 'MONEY_DELTA', delta: -fee, ruleId: rApply.id, reason: 'Simulated prescribed fee paid at the counter.', grounding: 'FICTIONAL_GAME_EVENT' },
        { kind: 'DAY_ADVANCE', days: 1, ruleId: rApply.id, reason: 'Travel to the counter and back.' },
        ...revealIf(ctx, ...feeClaimIds),
        ...completeEvidenceObjectives(ctx, feeClaimIds, rApply.id),
        { kind: 'OBJECTIVE_COMPLETE', objectiveId: 'o-name', ruleId: rApply.id, reason: 'The name search has been lodged.' },
      );

      if (tradingDay > 0 && ctx.state.day - tradingDay < 7) {
        events.push({
          id: 'late-search',
          title: 'The seven-day rule bites',
          body: `Section 17(2) requires the search to go out not less than seven days before you start trading. You started trading ${ctx.state.day - tradingDay} day(s) ago. The request is late and the Registrar can see that on the file.`,
          kind: 'OBSTACLE',
          grounding: 'VERIFIED',
          claimIds: ['C-RBN-06'],
          severity: 'warn',
        });
      }

      return [option('apply-name', `Lodge the name search. Costs the simulated prescribed fee of ${money(fee)}.`, effects, narration, { events })];
    }

    // --- Registration ----------------------------------------------------
    if (flagDecision !== 'granted') {
      return [
        option(
          'register-early',
          'Refuse to register before the name decision.',
          [idle('rApply')],
          [
            {
              text: `You cannot register a name the Registrar has not yet cleared. Section 17(3): you are entitled to register within twenty-eight days of the decision, and not before.`,
              grounding: 'VERIFIED',
              claimIds: ['C-RBN-07'],
            },
            sim(`So you wait. The queue does not care that you are waiting. ${day(ctx.state.day)} passes.`),
          ],
        ),
      ];
    }

    if (ctx.state.flags['registered'] === 'yes') {
      return [option('register-again', 'Already registered.', [], [sim(`You are registered. The Registrar is not going to be impressed by enthusiasm.`)])];
    }

    const decisionDay = Number(ctx.state.flags['nameDecisionDay'] ?? 0);
    const withinWindow = ctx.state.day - decisionDay <= 28;
    if (!withinWindow) {
      return [
        option(
          'register-lapsed',
          'The twenty-eight day window has closed.',
          [idle('rApply')],
          [
            { text: `The twenty-eight days in section 17(3) have run out. The name is no longer being held for you.`, grounding: 'VERIFIED', claimIds: ['C-RBN-07'] },
            sim(`You start the whole search again, and pay again, because that is how the system works on a bad day.`),
          ],
        ),
      ];
    }

    const narration: NarrationBlock[] = [
      {
        text: `The statement of particulars must state the business name, the general nature of the business, the full address of the principal place of business, your full name and nationality, and the date the business commenced (${'section 6(1)'}).`,
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-02'],
      },
      {
        text: `You are inside the twenty-eight days, so the name is yours.`,
        grounding: 'VERIFIED',
        claimIds: ['C-RBN-07'],
      },
      sim(`The Registrar stamps it. It is not a rubber thing, it is an actual stamp, and the sound it makes is the sound of a Tuesday changing shape.`),
      sim(`The certificate is issued on the spot here. In the fiction it costs nothing further.`),
    ];

    const effects: Effect[] = [
      { kind: 'FLAG_SET', flag: 'registered', value: 'yes', ruleId: rApply.id, reason: 'Registration completed.' },
      { kind: 'FLAG_SET', flag: 'registeredDay', value: ctx.state.day, ruleId: rApply.id, reason: 'Day of registration.' },
      {
        kind: 'ITEM_ADD',
        item: { id: 'certificate', label: 'Certificate of registration (issued)', quantity: 1, official: true, description: 'Issued under section 14(1) of the Registration of Business Names Act.' },
        ruleId: rApply.id,
        reason: 'Certificate received.',
        grounding: 'FICTIONAL_GAME_EVENT',
      },
      { kind: 'DAY_ADVANCE', days: 1, ruleId: rApply.id, reason: 'One more trip to the counter.' },
      ...revealIf(ctx, 'C-RBN-04', 'C-RBN-02'),
      { kind: 'OBJECTIVE_COMPLETE', objectiveId: 'o-register', ruleId: rApply.id, reason: 'The business name is registered.' },
    ];

    return [option('apply-register', 'Register the business name and collect the certificate.', effects, narration)];
  },
};

const rContact: Rule = {
  id: 'r-contact',
  purpose: 'Player contacts an authority. The counter quotes a simulated fee and refuses to be a source of law.',
  when: (ctx) => ctx.intent.type === 'CONTACT',
  resolve: (ctx) => {
    const narration: NarrationBlock[] = [];
    const effects: Effect[] = [];

    narration.push({
      text: `The Business Registration Service publishes a portal, states that an ID number is all you need to sign up, and lists mobile money, card and local bank transfer as ways to pay a service fee. It does not publish the amount (${'https://kbrs.pesaflow.com/'}).`,
      grounding: 'VERIFIED',
      claimIds: ['C-BP-02', 'C-BP-06'],
    });
    narration.push({
      text: `You are in a queue with a number above your head and a fan that is not helping. The man in front of you is arguing about a figure. The man behind you is arguing about the same figure differently.`,
      grounding: 'FICTIONAL_GAME_EVENT',
      claimIds: [],
    });
    narration.push(
      sim(`The clerk quotes ${money(SIM.prescribedFee)}. Invented for this game. The real figure is the prescribed fee, and nobody in this building will write it down for you because the rules, not the clerk, set it.`),
    );
    narration.push({
      text: `The Act authorises the Service to charge fees but states no amount, and delegates the amount to rules made by the Cabinet Secretary. This knowledge base does not hold those rules.`,
      grounding: 'UNKNOWN',
      claimIds: ['C-BRS-02', 'C-BRS-10'],
    });

    const feeClaims = ['C-BP-02', 'C-BP-06', 'C-BRS-02', 'C-BRS-10', 'C-RBN-17'];
    effects.push(
      { kind: 'FLAG_SET', flag: 'feeQuoted', value: 'yes', ruleId: rContact.id, reason: 'Fee quoted in fiction.' },
      { kind: 'DAY_ADVANCE', days: 1, ruleId: rContact.id, reason: 'A day in a queue.' },
      ...revealIf(ctx, ...feeClaims),
      ...completeEvidenceObjectives(ctx, feeClaims, rContact.id),
    );

    const events: GameEvent[] = [
      {
        id: 'quote-mismatch',
        title: 'The quote is not a source',
        body: `A clerk's figure is a fact about this queue, not about the law. The law is silent here and the secondary sources disagree with each other by a factor of seven.`,
        kind: 'SYSTEM',
        grounding: 'UNKNOWN',
        claimIds: ['C-BRS-10', 'C-RBN-17'],
        severity: 'warn',
      },
    ];

    return [option('contact', 'Get the simulated quote. Costs a day and teaches you nothing official.', effects, narration, { events })];
  },
};

const rTrade: Rule = {
  id: 'r-trade',
  purpose: 'Player tries to serve food. The twenty-eight day rule is enforced from section 8(1).',
  when: (ctx) =>
    /\b(trade|trading|cook|cooks|cooking|sell|sells|selling|serve|serves|serving|open up|start (?:trading|selling|business|cooking)|first customer|customer)\b/i.test(
      ctx.intent.text,
    ),
  resolve: (ctx) => {
    const hasKit =
      ctx.state.inventory.some((i) => i.id === 'trolley' || i.id === 'stove') &&
      ctx.state.inventory.some((i) => i.id === 'stock');
    if (!hasKit) {
      return [
        option(
          'trade-no-kit',
          'Cannot trade without a way to cook and something to cook.',
          [idle('rDisplay')],
          [sim(`You cannot cook with your hands. There is no trolley, no stove, no stock. The customers are not going to mind.`),
           { text: `The law, for its part, is indifferent to whether you can cook. Section 4 turns on the name you trade under, not on your equipment.`, grounding: 'VERIFIED', claimIds: ['C-RBN-01'] }],
        ),
      ];
    }

    const tradingDay = Number(ctx.state.flags['tradingDay'] ?? 0);
    const already = tradingDay > 0;
    if (!already) {
      // Starting to trade is the moment the twenty-eight day clock starts.
      const searchDay = Number(ctx.state.flags['nameSearchDay'] ?? 0);
      const narration: NarrationBlock[] = [
        sim(`You set up. The charcoal catches. A woman asks what you have and you tell her, and she says she will try, and she does, and she pays.`),
        {
          text: `You have now commenced business under a business name. Section 8(1): the statement of particulars is due within twenty-eight days of this moment.`,
          grounding: 'VERIFIED',
          claimIds: ['C-RBN-03'],
        },
      ];
      const effects: Effect[] = [
        { kind: 'FLAG_SET', flag: 'tradingDay', value: ctx.state.day, ruleId: rTrade.id, reason: 'Commenced business.' },
        { kind: 'DAY_ADVANCE', days: 1, ruleId: rTrade.id, reason: 'A day of trading.' },
        { kind: 'MONEY_DELTA', delta: -SIM.tradingBurn, ruleId: rTrade.id, reason: 'Simulated daily stock and charcoal cost.', grounding: 'FICTIONAL_GAME_EVENT' },
        ...revealIf(ctx, 'C-RBN-03'),
        { kind: 'OBJECTIVE_COMPLETE', objectiveId: 'o-trade', ruleId: rTrade.id, reason: 'First customer served.' },
      ];
      const events: GameEvent[] = [];
      if (searchDay === 0) {
        events.push({
          id: 'no-search',
          title: 'No search on file',
          body: `You are trading under a name and no search was ever lodged. Section 17(2) expected the request to go out at least seven days before you commenced.`,
          kind: 'OBSTACLE',
          grounding: 'VERIFIED',
          claimIds: ['C-RBN-06'],
          severity: 'danger',
        });
      }
      return [option('trade', 'Open for trade. Starts the twenty-eight day clock.', effects, narration, { events })];
    }

    return [
      option(
        'trade-again',
        'Trade another day. Costs the simulated daily burn.',
        [
          { kind: 'DAY_ADVANCE', days: 1, ruleId: rTrade.id, reason: 'A day of trading.' },
          { kind: 'MONEY_DELTA', delta: -SIM.tradingBurn, ruleId: rTrade.id, reason: 'Simulated daily cost.', grounding: 'FICTIONAL_GAME_EVENT' },
        ],
        [sim(`Another day. The charcoal is expensive and the sun is free and you are, for the moment, both.`)],
      ),
    ];
  },
};

const rDisplay: Rule = {
  id: 'r-display',
  purpose: 'Player hangs the certificate. Section 14(4) makes this an obligation, not a nicety.',
  when: (ctx) => /display|hang|show certificate|exhibit|certificate|wall|post it|frame/i.test(ctx.intent.text),
  resolve: (ctx) => {
    const hasCert = ctx.state.inventory.some((i) => i.id === 'certificate');
    if (!hasCert) {
      return [
        option(
          'display-none',
          'No certificate to display.',
          [idle('rDisplay')],
          [
            sim(`There is nothing to hang. The thing to do is register, and then there will be something to hang.`),
            {
              text: `Section 14(1): on the registration of any firm, individual or corporation, the Registrar shall issue a certificate.`,
              grounding: 'VERIFIED',
              claimIds: ['C-RBN-04'],
            },
          ],
        ),
      ];
    }
    if (ctx.state.flags['displayed'] === 'yes') {
      return [option('display-again', 'Already displayed.', [], [sim(`It is on the trolley. It has been there since the morning you hung it.`)])];
    }
    return [
      option(
        'display',
        'Exhibit the certificate. Completes the display obligation.',
        [
          { kind: 'FLAG_SET', flag: 'displayed', value: 'yes', ruleId: rDisplay.id, reason: 'Certificate exhibited.' },
          ...revealIf(ctx, 'C-RBN-05'),
          { kind: 'OBJECTIVE_COMPLETE', objectiveId: 'o-display', ruleId: rDisplay.id, reason: 'Certificate displayed as required.' },
        ],
        [
          {
            text: `Section 14(4): the certificate must be exhibited and thereafter maintained in a conspicuous position at the principal place of business. Failing to do so is an offence under section 14(6).`,
            grounding: 'VERIFIED',
            claimIds: ['C-RBN-05'],
          },
          sim(`You drill two holes and hang it where the steam will not reach. It is the first thing a customer sees, and the second thing is the price list.`),
        ],
      ),
    ];
  },
};

const rOwnName: Rule = {
  id: 'r-own-name',
  purpose: 'Player discovers the section 4(b) route: trading under your own surname alone may not trigger registration.',
  when: (ctx) => /own name|my name|surname|no registration|skip|bypass|without registering|own surname/i.test(ctx.intent.text),
  resolve: (ctx) => [
    option(
      'own-name',
      'Take the section 4(b) route: trade under your own surname alone.',
      [
        { kind: 'FLAG_SET', flag: 'ownNameRoute', value: 'yes', ruleId: rOwnName.id, reason: 'Trading under own surname.' },
        ...revealIf(ctx, 'C-RBN-01'),
        { kind: 'OBJECTIVE_FAIL', objectiveId: 'o-register', ruleId: rOwnName.id, reason: 'Chose not to register.' },
        { kind: 'OBJECTIVE_FAIL', objectiveId: 'o-display', ruleId: rOwnName.id, reason: 'No certificate exists.' },
        { kind: 'OBJECTIVE_FAIL', objectiveId: 'o-name', ruleId: rOwnName.id, reason: 'No name search required.' },
        { kind: 'DAY_ADVANCE', days: 1, ruleId: rOwnName.id, reason: 'A day spent deciding.' },
      ],
      [
        {
          text: `Section 4(b): registration is required of an individual carrying on business under a name "which does not consist of his surname without any addition other than his forenames or the initials thereof". Read strictly, trading as plain "Achieng'" is not a registration trigger.`,
          grounding: 'VERIFIED',
          claimIds: ['C-RBN-01'],
        },
        sim(`You write the name on a piece of cardboard. It is your name. It is the cheapest branding available anywhere in the world.`),
        sim(`What you give up: no certificate, no registration, and section 11's shadow still hanging around any contract you sign.`),
      ],
    ),
  ],
};

const rWait: Rule = {
  id: 'r-wait',
  purpose: 'Player waits. Registrar decisions land. The seven-day response window advances.',
  when: (ctx) => ctx.intent.type === 'WAIT' || /^wait|do nothing|rest|idle/i.test(ctx.intent.text),
  resolve: (ctx) => {
    const days = Number(ctx.state.flags['tradingDay'] ?? 0) > 0 ? 2 : 1;
    const effects: Effect[] = [
      { kind: 'DAY_ADVANCE', days, ruleId: rWait.id, reason: 'Waiting advances the calendar.' },
    ];
    const narration: NarrationBlock[] = [sim(`You wait. The light changes twice. Nothing, in the useful sense, happens.`)];
    const events: GameEvent[] = [];

    if (ctx.state.flags['nameSearchLodged'] === 'yes' && ctx.state.flags['nameDecision'] === undefined) {
      const lodged = Number(ctx.state.flags['nameSearchDay'] ?? 0);
      if (ctx.state.day - lodged >= 7) {
        const refusal = ctx.rng.next() < 0.3;
        effects.push(
          { kind: 'FLAG_SET', flag: 'nameDecision', value: refusal ? 'refused' : 'granted', ruleId: rWait.id, reason: 'Registrar decision.' },
          { kind: 'FLAG_SET', flag: 'nameDecisionDay', value: ctx.state.day, ruleId: rWait.id, reason: 'Day of decision.' },
          ...revealIf(ctx, 'C-RBN-08'),
        );
        if (refusal) {
          narration.push({
            text: `The decision comes back negative. The Registrar refuses names that are identical or similar to an existing registration, and names he considers undesirable. He cites the first ground and does not elaborate.`,
            grounding: 'VERIFIED',
            claimIds: ['C-RBN-08'],
          });
          narration.push(sim(`Section 17(3) gives you twenty-eight days to register a cleared name. A refused name does not get that window. You pay again, or you rename.`));
          events.push({ id: 'name-refused', title: 'Name refused', body: 'The Registrar refused your proposed name. Section 17(1) lists the grounds, and he used one of them.', kind: 'OBSTACLE', grounding: 'VERIFIED', claimIds: ['C-RBN-08'], severity: 'danger' });
        } else {
          narration.push(sim(`The letter says the name may be registered. You have twenty-eight days to act on it, and no other party may take it in the meantime.`));
        }
      }
    }

    return [option('wait', `Wait ${days} day(s).`, effects, narration, { events })];
  },
};

const rTravel: Rule = {
  id: 'r-travel',
  purpose: 'Player moves around Nairobi. Costs a fare and a day; occasionally saves one.',
  when: (ctx) => ctx.intent.type === 'TRAVEL' || /matatu|bus|travel|go to|commute|ride/i.test(ctx.intent.text),
  resolve: () => [
    option(
      'travel',
      `Move around the city. Costs ${money(SIM.matatuFare)} and a day.`,
      [
        { kind: 'MONEY_DELTA', delta: -SIM.matatuFare, ruleId: rTravel.id, reason: 'Simulated matatu fare.', grounding: 'FICTIONAL_GAME_EVENT' },
        { kind: 'DAY_ADVANCE', days: 1, ruleId: rTravel.id, reason: 'Travel consumes the day.' },
      ],
      [sim(`A matatu, a conductor, and a seat taken by a man who is going exactly where you are going. The fare is what it is.`)],
    ),
  ],
};

const rCustom: Rule = {
  id: 'r-custom',
  purpose: 'Catch-all. Does nothing except cost a day, and says so honestly.',
  when: () => true,
  resolve: (ctx) => [
    option(
      'custom',
      'The scenario has no rule for this. A day passes.',
      [{ kind: 'DAY_ADVANCE', days: 1, ruleId: rCustom.id, reason: 'An unmodelled action consumes the day.' }],
      [sim(`You do the thing. The scenario has no rule for it, so the simulation will not pretend otherwise: the day is spent and nothing in the state changes.`)],
    ),
  ],
};

/* -------------------------------------------------------------------------- */
/* Ambient events                                                              */
/* -------------------------------------------------------------------------- */

const AMBIENT: AmbientEvent[] = [
  {
    id: 'matatu',
    title: 'A matatu conductor',
    body: 'He wants exactly what you owe and no more, which is a rare kind of honesty.',
    kind: 'SYSTEM',
    severity: 'info',
    weight: 2,
    effects: (rng) => [
      { kind: 'MONEY_DELTA', delta: -rng.int(40, 60), ruleId: 'evt-matatu', reason: 'Fare.', grounding: 'FICTIONAL_GAME_EVENT' },
    ],
  },
  {
    id: 'spice-market',
    title: 'The price of onions',
    body: 'Onions are up, or down, or exactly where they were. It depends on the day and nobody can tell you which in advance.',
    kind: 'OPPORTUNITY',
    severity: 'info',
    weight: 2,
    effects: (rng) => [
      { kind: 'MONEY_DELTA', delta: rng.next() < 0.5 ? -rng.int(80, 200) : rng.int(20, 90), ruleId: 'evt-market', reason: 'Market movement.', grounding: 'FICTIONAL_GAME_EVENT' },
    ],
  },
  {
    id: 'clerk-grumble',
    title: 'A clerk who has seen it all',
    body: 'He does not tell you the fee. He tells you that everyone asks for the fee, and that the ones who ask for it and the ones who pretend to know it are both disappointed.',
    kind: 'SYSTEM',
    severity: 'info',
    weight: 1,
    when: ({ state }) => state.flags['feeQuoted'] !== 'yes',
    effects: () => [],
  },
  {
    id: 'rain',
    title: 'The rains start early',
    body: 'Nobody in this fiction predicted the rains either. Customers thin out. The trolley leaks.',
    kind: 'OBSTACLE',
    severity: 'warn',
    weight: 1,
    effects: (rng) => [
      { kind: 'MONEY_DELTA', delta: -rng.int(100, 250), ruleId: 'evt-rain', reason: 'Lost trade.', grounding: 'FICTIONAL_GAME_EVENT' },
      { kind: 'DAY_ADVANCE', days: 1, ruleId: 'evt-rain', reason: 'A rained-out day.' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Scenario                                                                    */
/* -------------------------------------------------------------------------- */

export const nairobiFood: ScenarioDefinition = {
  id: 'mission-001-umoja-food-point',
  title: 'Umoja wa Wananchi Food Point',
  subtitle: 'Start a small food business in Nairobi with KSh 8,000',
  brief:
    'You are Achieng\' Otieno, twenty-nine, with KSh 8,000 and no registered business. You want to cook and sell food. Somewhere in this city is a process that will make it official, and it costs money you do not have and time you cannot spare.',
  playerProfile:
    'Achieng\' Otieno, 29. No registered business. KSh 8,000 and a rented room. Knows how to cook; does not know how to be a company.',
  maxTurns: MAX_TURNS,
  startingMoney: SIM.startingMoney,
  startDay: START_DAY,
  calendarEpoch: CALENDAR_EPOCH,
  objectives: OBJECTIVES,
  endings: ENDINGS,
  // Order matters. The most specific reading of a sentence wins, so the
  // narrow "display the certificate" and "trade under my own name" rules come
  // before the broad "start trading" rule that would otherwise swallow them.
  rules: [rSurvey, rAsk, rBuy, rApply, rContact, rDisplay, rOwnName, rTrade, rWait, rTravel, rCustom],
  ambient: AMBIENT,
  evidenceSeedQueries: [
    'business name registration requirement Kenya',
    'prescribed fee registration amount',
    'how long to register a business name',
    'certificate display requirement',
    'what is the deadline to register after starting business',
  ],
  opening: () => [
    sim(`${CALENDAR_EPOCH}. You are standing outside your rented room in ${'Nairobi'} with KSh 8,000 and a decision.`),
    sim(`The goal is not complicated: cook something, sell it, and be a real business rather than a rumour of one. The process for being a real business is where it gets complicated.`),
    sim(`You have ${MAX_TURNS} turns. Each one costs a day or two of a life that is happening whether you fill it or not.`),
  ],
};
