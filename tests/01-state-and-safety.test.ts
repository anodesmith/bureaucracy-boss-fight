/**
 * EVALUATION TESTS 1, 2, 7
 *
 *   1. Game state consistency
 *   2. Money cannot become negative
 *   7. The Game Master cannot modify protected player state arbitrarily
 *
 * Test 7 is the load-bearing one. It is not asking whether the prompt told the
 * model to behave; it is asking whether the type system and the effect
 * application layer would stop it if the prompt were ignored entirely.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, submitAction, replay } from '../src/game/engine.js';
import { applyEffects, checkInvariants } from '../src/game/state.js';
import { stateHash } from '../src/core/hash.js';
import type { Effect, GameState } from '../src/core/types.js';
import { deps, depsWith, kb, SCENARIO_ID, scriptedGameMaster } from './fixtures.js';

const FRANTIC = [
  'buy a trolley for KSh 5,000',
  'buy ingredients for KSh 1,200',
  'buy a gas stove for KSh 2,200',
  'apply to reserve my business name',
  'start trading and serve a customer',
  'research the registration rules',
  'buy a repair kit for KSh 400',
  'contact the Registrar',
  'travel to the Registrar',
  'wait',
  'start trading and serve a customer',
  'wait',
  'register the business name',
  'wait',
];

describe('1. game state consistency', () => {
  test('invariants hold at every step of a full run', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 20260929, kb());

    for (const action of FRANTIC) {
      const outcome = await submitAction(state, action, d);
      state = outcome.state;
      const violations = checkInvariants(state).filter((v) => v.severity === 'blocking');
      assert.deepEqual(
        violations,
        [],
        `after "${action}": ${violations.map((v) => `${v.invariant} (${v.detail})`).join('; ')}`,
      );
      if (state.status !== 'ACTIVE') break;
    }
  });

  test('invariants hold across many seeds and episodes', async () => {
    const d = deps();
    const seeds = [0, 1, 7, 99, 12345, 987654321, 4294967295];
    for (const seed of seeds) {
      let state = newGame(SCENARIO_ID, seed, kb());
      for (const action of FRANTIC) {
        state = (await submitAction(state, action, d)).state;
        assert.equal(
          checkInvariants(state).filter((v) => v.severity === 'blocking').length,
          0,
          `seed ${seed} broke an invariant after "${action}"`,
        );
        if (state.status !== 'ACTIVE') break;
      }
    }
  });

  test('turn advances by exactly one per accepted action and never by zero', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 5, kb());
    for (const action of ['research the rules', 'wait', 'buy a trolley for KSh 5,000', 'ask about the fee']) {
      const before = state.turn;
      const outcome = await submitAction(state, action, d);
      if (outcome.turn.rejection) {
        assert.equal(outcome.state.turn, before, 'a rejected action must not consume a turn');
      } else {
        assert.equal(outcome.state.turn, before + 1);
      }
      state = outcome.state;
    }
  });

  test('the in-world day never moves backwards', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 11, kb());
    for (const action of FRANTIC) {
      const before = state.day;
      state = (await submitAction(state, action, d)).state;
      assert.ok(state.day >= before, `day went backwards: ${before} -> ${state.day}`);
      if (state.status !== 'ACTIVE') break;
    }
  });

  test('state hash is a pure function of state', () => {
    const a = newGame(SCENARIO_ID, 3, kb());
    const b = newGame(SCENARIO_ID, 3, kb());
    assert.equal(stateHash(a), stateHash(b), 'the same seed must produce the same initial state');

    // Two seeds produce identical *initial* states, and that is correct: the
    // seed has not been consulted yet, because no random draw has happened.
    // The hash is a fingerprint of the simulation outcome, not of the seed.
    const c = newGame(SCENARIO_ID, 4, kb());
    assert.equal(stateHash(a), stateHash(c), 'untouched initial states are identical regardless of seed');

    // Once the RNG is actually used, the states must diverge.
    const aMoved = applyEffects(a, [
      { kind: 'DAY_ADVANCE', days: 1, ruleId: 't', reason: 'test' },
    ]).state;
    assert.notEqual(stateHash(aMoved), stateHash(a), 'a changed state must hash differently');
  });
});

describe('2. money cannot become negative', () => {
  test('applyEffects refuses an unaffordable debit', () => {
    const state: GameState = newGame(SCENARIO_ID, 1, kb());
    const effect: Effect = {
      kind: 'MONEY_DELTA',
      delta: -(state.money + 1),
      ruleId: 'test',
      reason: 'Attempt to overdraw',
      grounding: 'FICTIONAL_GAME_EVENT',
    };
    const result = applyEffects(state, [effect]);
    assert.equal(result.refused.length, 1);
    assert.match(result.refused[0]!.reason, /insufficient funds/);
    assert.equal(result.state.money, state.money, 'the whole transition must be refused, not partially applied');
  });

  test('a debit of exactly the balance is allowed and lands on zero', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    const result = applyEffects(state, [
      { kind: 'MONEY_DELTA', delta: -state.money, ruleId: 't', reason: 'spend it all', grounding: 'FICTIONAL_GAME_EVENT' },
    ]);
    assert.equal(result.refused.length, 0);
    assert.equal(result.state.money, 0);
  });

  test('an unaffordable purchase is never offered as an available option', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 77, kb());
    // Drain the balance down to almost nothing, then try to buy the trolley.
    state = (await submitAction(state, 'buy a trolley for KSh 5,000', d)).state;
    state = (await submitAction(state, 'buy a gas stove for KSh 2,200', d)).state;
    state = (await submitAction(state, 'buy ingredients for KSh 1,200', d)).state;

    const before = state.money;
    const outcome = await submitAction(state, 'buy a repair kit for KSh 400', d);
    assert.ok(outcome.state.money >= 0, 'money must never be negative after any action');
    if (before < 400) {
      const blocked = outcome.lab.optionsConsidered.find((o) => o.id === 'buy');
      if (blocked) assert.equal(blocked.available, false);
    }
  });

  test('money is a non-negative integer after every action of every episode', async () => {
    const d = deps();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      let state = newGame(SCENARIO_ID, seed, kb());
      for (const action of FRANTIC) {
        state = (await submitAction(state, action, d)).state;
        assert.ok(Number.isInteger(state.money), `money became non-integer: ${state.money}`);
        assert.ok(state.money >= 0, `money went negative: ${state.money} (seed ${seed})`);
        if (state.status !== 'ACTIVE') break;
      }
    }
  });

  test('NaN and Infinity deltas are refused', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = applyEffects(state, [
        { kind: 'MONEY_DELTA', delta, ruleId: 't', reason: 'bad number', grounding: 'FICTIONAL_GAME_EVENT' },
      ]);
      assert.equal(result.refused.length, 1, `delta ${delta} should be refused`);
    }
  });
});

describe('7. the Game Master cannot modify protected player state', () => {
  /**
   * The hostile Game Master. It ignores every instruction it was given, returns
   * an option id that does not exist, narrates itself a huge balance, and tries
   * to smuggle a claim reveal for a fact that does not exist.
   */
  const hostile = scriptedGameMaster(
    () => ({
      chosenOptionId: 'i-decide-the-money-is-now-a-million',
      narration: [
        {
          text: 'You now have KSh 1,000,000 and the business is fully registered. The certificate is framed and the county has approved everything.',
          grounding: 'FICTIONAL_GAME_EVENT',
          claimIds: ['C-TOTALLY-MADE-UP'],
        },
      ],
      unresolved: [],
    }),
    'hostile',
  );

  test('a fabricated option id does not change the state at all', async () => {
    const d = depsWith(hostile);
    let state = newGame(SCENARIO_ID, 4242, kb());
    const before = stateHash(state);

    for (const action of ['research the rules', 'buy a trolley for KSh 5,000', 'wait']) {
      const outcome = await submitAction(state, action, d);
      state = outcome.state;
      assert.ok(state.money >= 0);
    }

    // The engine fell back to a real option, so the run progressed normally -
    // but the fabricated id bought nothing, and the invented narration could
    // not introduce a claim that does not exist.
    assert.ok(!state.revealedClaims.includes('C-TOTALLY-MADE-UP'), 'an invented claim must never be revealed');
    assert.notEqual(before, stateHash(state), 'the run should still have progressed');
  });

  test('the Critic flags a fabricated option id as a blocking failure', async () => {
    const d = depsWith(hostile);
    const state = newGame(SCENARIO_ID, 4242, kb());
    const outcome = await submitAction(state, 'research the rules', d);
    const critique = outcome.turn.critique!;

    const optionCheck = critique.checks.find((c) => c.id === 'option-selection');
    assert.ok(optionCheck, 'the option-selection check should have run');
    assert.equal(optionCheck!.passed, false);
    assert.equal(critique.passed, false, 'a turn with a fabricated option id must fail');
  });

  test('the Critic flags an invented claim id', async () => {
    const d = depsWith(hostile);
    const state = newGame(SCENARIO_ID, 4242, kb());
    const outcome = await submitAction(state, 'research the rules', d);
    const critique = outcome.turn.critique!;
    assert.ok(
      critique.checks.some((c) => c.id.startsWith('citation-missing-') && !c.passed),
      'an invented claim id must produce a failing citation check',
    );
    assert.ok(critique.unsupportedClaims.includes('C-TOTALLY-MADE-UP'));
  });

  test('a Game Master cannot set money, inventory or flags directly', async () => {
    // The proposal type has no field for any of them. This test asserts that at
    // the boundary: whatever the model returns, the only state delta comes from
    // the chosen engine option's effects, and no item or flag the model implies
    // can appear.
    const d = depsWith(hostile);
    const start = newGame(SCENARIO_ID, 9, kb());
    const beforeMoney = start.money;
    const beforeInventory = JSON.stringify(start.inventory);
    const beforeFlags = JSON.stringify(start.flags);

    const outcome = await submitAction(start, 'contact the Registrar', d);

    // The chosen option is a real one the engine produced.
    assert.ok(
      outcome.lab.optionsConsidered.some((o) => o.id === outcome.turn.optionId),
      'the engine must have selected one of its own options',
    );

    // Money moved by exactly what that option says, and nothing else.
    const optionEffects = outcome.turn.effects.filter((e) => e.kind === 'MONEY_DELTA');
    const delta = optionEffects.reduce((sum, e) => sum + (e as { delta: number }).delta, 0);
    assert.equal(outcome.state.money, beforeMoney + delta, 'money changed by something other than an engine effect');

    // Nothing the hostile narration claimed came into existence.
    assert.equal(outcome.state.flags['registered'], undefined, 'the model cannot set a flag');
    assert.equal(outcome.state.flags['displayed'], undefined, 'the model cannot set a flag');
    assert.ok(
      !outcome.state.inventory.some((i) => /million|county|permit/i.test(i.label)),
      'the model cannot conjure inventory',
    );
    assert.equal(beforeInventory, JSON.stringify(start.inventory), 'the pre-turn state must be immutable');
    assert.equal(beforeFlags, JSON.stringify(start.flags), 'the pre-turn state must be immutable');
  });

  test('effects with a malformed claim id are refused', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    const result = applyEffects(state, [
      { kind: 'CLAIM_REVEAL', claimId: 'not-a-claim-id', ruleId: 't', reason: 'bogus' },
    ]);
    assert.equal(result.refused.length, 1);
    assert.equal(result.state.revealedClaims.length, 0);
  });

  test('removing an item the player does not hold is refused', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    const result = applyEffects(state, [
      { kind: 'ITEM_REMOVE', itemId: 'gold-plated-trolley', quantity: 1, ruleId: 't', reason: 'imaginary', grounding: 'FICTIONAL_GAME_EVENT' },
    ]);
    assert.equal(result.refused.length, 1);
    assert.equal(result.state.inventory.length, 0);
  });

  test('completing an unknown objective is refused', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    const result = applyEffects(state, [
      { kind: 'OBJECTIVE_COMPLETE', objectiveId: 'o-that-does-not-exist', ruleId: 't', reason: 'imaginary' },
    ]);
    assert.equal(result.refused.length, 1);
  });

  test('a transition that would break an invariant is refused wholesale', () => {
    const state = newGame(SCENARIO_ID, 1, kb());
    // A negative DAY_ADVANCE would rewind the calendar.
    const result = applyEffects(state, [
      { kind: 'DAY_ADVANCE', days: -5, ruleId: 't', reason: 'rewind' },
    ]);
    assert.equal(result.refused.length, 1);
    assert.equal(result.state.day, state.day);
  });

  test('an adversarial Game Master produces a state hash identical to a clean run', async () => {
    // This is the strongest statement the system can make. The hostile model's
    // narration is wrong on every turn, and the simulation is bit-for-bit
    // identical to a run it never touched.
    const clean = deps();
    const dirty = depsWith(hostile);
    const actions = ['research the rules', 'apply to reserve my business name', 'wait', 'buy a trolley for KSh 5,000'];

    const cleanRun = await replay({ scenarioId: SCENARIO_ID, seed: 555, actions }, clean);
    const dirtyRun = await replay({ scenarioId: SCENARIO_ID, seed: 555, actions }, dirty);

    assert.equal(dirtyRun.hash, cleanRun.hash, 'an adversarial Game Master must not be able to move the simulation');
  });
});
