# Adding a mission

A mission is data plus a set of rules. Nothing about it needs to know that
language models exist.

## 1. Create the scenario

Copy `src/game/scenarios/nairobi-food.ts` to a new file and work from it. It is
heavily commented; the comments explain *why* each piece exists.

You need to supply:

| Field | Meaning |
| --- | --- |
| `id`, `title`, `subtitle`, `brief` | Identity and framing |
| `startingMoney`, `maxTurns`, `startDay` | The budget |
| `objectives` | What winning looks like |
| `endings` | The graded outcomes |
| `rules` | Ordered `Rule[]` |
| `ambient` | Seeded random events |
| `opening()` | First narration |

## 2. Write the rules

A rule is `{ id, purpose, when(ctx), resolve(ctx) }`.

```ts
const rBuy: Rule = {
  id: 'r-buy',
  purpose: 'One line, shown in Lab Mode. Not chain-of-thought.',
  when: (ctx) => ctx.intent.type === 'BUY',
  resolve: (ctx) => [
    option(
      'buy',                                   // option id the Game Master picks
      'Short description, shown in Lab Mode.', // also the summary line
      [ /* Effect[] - the only way state changes */ ],
      [ /* NarrationBlock[] - each labelled */ ],
    ),
  ],
};
```

Rules are tried **in order** and the first match wins, so order from most
specific to least. `the-grinder` says "register the business name", which
matches both a "register" rule and a "name" rule — put registration first or
the player will be sent back to the counter.

## 3. Effects

The only effect types are in `src/core/types.ts`. The ones you will use:

```ts
{ kind: 'MONEY_DELTA', delta: -1000, ruleId, reason, grounding }
{ kind: 'ITEM_ADD', item: { id, label, quantity, official, description }, ruleId, reason, grounding }
{ kind: 'ITEM_REMOVE', itemId, quantity, ruleId, reason, grounding }
{ kind: 'FLAG_SET', flag: 'nameSearchLodged', value: 'yes', ruleId, reason }
{ kind: 'CLAIM_REVEAL', claimId: 'C-RBN-06', ruleId, reason }
{ kind: 'OBJECTIVE_COMPLETE', objectiveId, ruleId, reason }
{ kind: 'OBJECTIVE_FAIL', objectiveId, ruleId, reason }
{ kind: 'DAY_ADVANCE', days: 1, ruleId, reason }
```

Three rules that matter:

- **Prices come from the scenario, never from a model.** Put them in a `SIM`
  constant and narrate them as `[SIMULATION]`. A price the player sees must be
  a number you wrote down.
- **An option that costs money gets gated on funds automatically** by
  `gateOnFunds`. You do not write that check.
- **A no-op option still costs a day.** Use `idle(ruleId)`. Otherwise the
  player can stall for free and the deadline stops meaning anything.

## 4. Narration and grounding

Every block carries a label:

```ts
// Real, cited, and the engine can prove it.
{ text: 'Section 8(1): the statement of particulars is due within 28 days.',
  grounding: 'VERIFIED', claimIds: ['C-RBN-03'] }

// Fiction. Prices, weather, queues.
{ text: 'The charcoal catches.', grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] }

// You do not know. Say so and explain why.
{ text: 'The amount of the prescribed fee is not stated in the Act.',
  grounding: 'UNKNOWN', claimIds: ['C-RBN-17'] }
```

Rules that will get you in trouble:

- A `VERIFIED` block with no `claimIds` fails the Critic immediately.
- A `FICTIONAL_GAME_EVENT` block that tells the player a real institution
  requires something specific fails as a masquerade. `looksLikeInventedRequirement`
  in `agents/evidence/index.ts` is the exact test.
- A citation that does not overlap the assertion fails validation. Cite the
  claim that actually says the thing you are saying.

## 5. Register it

```ts
// src/game/engine.ts
const SCENARIOS = new Map([
  [nairobiFood.id, nairobiFood],
  [yourMission.id, yourMission],
]);
```

That is the whole registration step.

## 6. Check it

```bash
npm run typecheck
npm test
npx tsx src/scripts/smoke.ts    # add your action script to SCRIPT
npm run eval
```

## Design notes worth stealing

- **Make the budget impossible.** The player should not be able to do
  everything. If they can, there is no game.
- **Let the law be the antagonist.** The hardest deadlines in this mission are
  real: seven days before trading, twenty-eight days to register, hang the
  certificate. A player who discovers section 4(b) and trades under their own
  surname is playing correctly, and should get a real, different ending.
- **Grade at the end, not mid-run.** An early version ended the run the moment
  the player served a customer, which meant you could "win" without ever
  registering. Only money and turns should end a run early.
- **Keep the UNKNOWN load-bearing.** The best thing in this mission is a
  question the game cannot answer. If every question has an answer, the
  grounding model has nothing to demonstrate.
