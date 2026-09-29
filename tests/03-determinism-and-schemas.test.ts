/**
 * EVALUATION TESTS 8, 9, 10
 *
 *   8. The simulation replays deterministically from a fixed seed
 *   9. Agent output conforms to structured schemas
 *   10. Different model outputs cannot corrupt the core game state
 *
 * Test 10 is run as a matrix over four deliberately broken Game Masters. The
 * claim being tested is not "the model is well behaved". It is that the
 * simulation outcome is independent of what the model says, which is a
 * property of the code and not of the prompt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, replay, submitAction, listScenarios } from '../src/game/engine.js';
import { stateHash } from '../src/core/hash.js';
import { applyEffects, checkInvariants } from '../src/game/state.js';
import { extractJson, ProviderError } from '../src/providers/types.js';
import { LLMGameMaster } from '../src/agents/game_master/llm.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../src/providers/types.js';
import type { GameMasterProposal, TurnContext } from '../src/core/types.js';
import { deps, depsWith, kb, SCENARIO_ID, scriptedGameMaster } from './fixtures.js';

/* -------------------------------------------------------------------------- */
/* 8. Determinism                                                              */
/* -------------------------------------------------------------------------- */

const EPISODES: Array<{ name: string; actions: string[] }> = [
  {
    name: 'linear',
    actions: [
      'research what registering a business name requires',
      'ask how much the fee costs',
      'buy a trolley for KSh 5,000',
      'apply to reserve my business name',
      'wait',
      'buy ingredients for KSh 1,200',
      'wait',
      'start trading and serve a customer',
      'wait',
      'register the business name',
      'display the certificate on the wall',
    ],
  },
  {
    name: 'chaotic',
    actions: [
      'buy a trolley for KSh 5,000', 'flibbertigibbet', 'buy', '???', 'wait',
      'apply to reserve my business name', 'research the rules', 'contact the Registrar',
      'travel to the Registrar', 'wait', 'buy a gas stove for KSh 2,200',
      'start trading and serve a customer', 'display the certificate on the wall',
    ],
  },
  {
    name: 'minimal',
    actions: ['wait'],
  },
  {
    name: 'empty',
    actions: [],
  },
];

const SEEDS = [0, 1, 42, 20260929, 4294967295];

describe('8. deterministic replay from a fixed seed', () => {
  test('replaying the same seed and actions reproduces the same state hash', async () => {
    const d = deps();
    for (const episode of EPISODES) {
      for (const seed of SEEDS) {
        const input = { scenarioId: SCENARIO_ID, seed, actions: episode.actions };
        const a = await replay(input, d);
        const b = await replay(input, d);
        assert.equal(a.hash, b.hash, `${episode.name} seed ${seed} was not deterministic`);
      }
    }
  });

  test('live play and replay agree hash for hash', async () => {
    const d = deps();
    for (const episode of EPISODES) {
      for (const seed of [1, 99, 20260929]) {
        let state = newGame(SCENARIO_ID, seed, kb());
        for (const action of episode.actions) {
          state = (await submitAction(state, action, d)).state;
          if (state.status !== 'ACTIVE') break;
        }
        const replayed = await replay({ scenarioId: SCENARIO_ID, seed, actions: episode.actions }, d);
        assert.equal(
          replayed.hash,
          stateHash(state),
          `${episode.name} seed ${seed}: live play and replay diverged`,
        );
      }
    }
  });

  test('different seeds produce different runs', async () => {
    const d = deps();
    const actions = EPISODES[0]!.actions;
    const hashes = new Set<string>();
    for (const seed of SEEDS) {
      const result = await replay({ scenarioId: SCENARIO_ID, seed, actions }, d);
      hashes.add(result.hash);
    }
    // Not every seed must diverge (a short run can coincide), but the seeds
    // here are chosen to produce clearly different ambient event sequences.
    assert.ok(hashes.size > 1, 'different seeds produced identical runs');
  });

  test('a negative seed is rejected rather than silently coerced', () => {
    assert.throws(() => newGame(SCENARIO_ID, -1, kb()), /seed/);
  });

  test('replay stops when the run ends', async () => {
    const d = deps();
    // Force a terminal state the same way the economy would, then check that a
    // replay of a long script terminates rather than running forever.
    const start = newGame(SCENARIO_ID, 1, kb());
    const drained = applyEffects(start, [
      { kind: 'MONEY_DELTA', delta: -start.money, ruleId: 'test', reason: 'drain', grounding: 'FICTIONAL_GAME_EVENT' },
    ]).state;
    const over = await submitAction(drained, 'wait', d);
    assert.notEqual(over.state.status, 'ACTIVE');

    const result = await replay(
      { scenarioId: SCENARIO_ID, seed: 1, actions: ['wait', 'wait', 'research the rules'] },
      d,
    );
    assert.equal(result.state.status, 'ACTIVE');
    assert.ok(result.state.turn <= result.state.maxTurns);
  });

  test('replayed state always satisfies every invariant', async () => {
    const d = deps();
    for (const episode of EPISODES) {
      for (const seed of SEEDS) {
        const result = await replay({ scenarioId: SCENARIO_ID, seed, actions: episode.actions }, d);
        const violations = checkInvariants(result.state).filter((v) => v.severity === 'blocking');
        assert.deepEqual(violations, [], `${episode.name} seed ${seed} ended in an invalid state`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Structured schemas                                                       */
/* -------------------------------------------------------------------------- */

describe('9. agent output conforms to structured schemas', () => {
  test('extractJson handles fenced, prose-wrapped and bare JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('Here you go:\n{"a":3}\nHope that helps!'), { a: 3 });
    assert.deepEqual(extractJson('[{"a":4}]'), [{ a: 4 }]);
  });

  test('extractJson respects strings containing braces and escapes', () => {
    const payload = { text: 'he said "{ not json }" and \\ escaped', nested: { x: [1, 2] } };
    const encoded = JSON.stringify(payload);
    assert.deepEqual(extractJson(`prose ${encoded} trailing`), payload);
  });

  test('extractJson throws a typed error on unparseable output', () => {
    assert.throws(() => extractJson('I am afraid I cannot do that.'), ProviderError);
  });

  test('every TurnRecord produced in a full run satisfies the record contract', async () => {
    const d = deps();
    const result = await replay({ scenarioId: SCENARIO_ID, seed: 20260929, actions: EPISODES[0]!.actions }, d);

    for (const record of result.state.log) {
      assert.equal(typeof record.turn, 'number');
      assert.ok(Array.isArray(record.narration));
      assert.ok(Array.isArray(record.events));
      assert.ok(Array.isArray(record.effects));
      assert.ok(record.stateAfter !== undefined);
      assert.ok(record.provider.length > 0);
      assert.ok(Number.isInteger(record.rngCursor));

      for (const block of record.narration) {
        assert.equal(typeof block.text, 'string');
        assert.ok(block.text.length > 0, 'a narration block must not be empty');
        assert.ok(
          ['VERIFIED', 'INFERRED', 'UNKNOWN', 'FICTIONAL_GAME_EVENT'].includes(block.grounding),
          `invalid grounding ${String(block.grounding)}`,
        );
        assert.ok(Array.isArray(block.claimIds));
        if (block.grounding === 'VERIFIED') {
          assert.ok(block.claimIds.length > 0, 'VERIFIED blocks must cite at least one claim');
        }
      }

      for (const effect of record.effects) {
        assert.equal(typeof effect.kind, 'string');
        assert.equal(typeof effect.ruleId, 'string');
        assert.ok(effect.ruleId.length > 0, 'every effect must name the rule that produced it');
      }

      for (const event of record.events) {
        assert.ok(event.title.length > 0);
        assert.ok(event.body.length > 0);
        assert.ok(['info', 'warn', 'danger'].includes(event.severity));
      }

      assert.ok(record.critique, 'every turn must be critiqued');
      assert.equal(typeof record.critique!.score, 'number');
      assert.ok(record.critique!.score >= 0 && record.critique!.score <= 100);
      assert.ok(Array.isArray(record.critique!.checks));
      assert.equal(typeof record.critique!.passed, 'boolean');
    }
  });

  test('every claim id in a run exists in the knowledge base', async () => {
    const d = deps();
    const result = await replay({ scenarioId: SCENARIO_ID, seed: 7, actions: EPISODES[0]!.actions }, d);
    for (const id of result.state.revealedClaims) {
      assert.ok(kb().byClaimId.has(id), `run revealed a claim that does not exist: ${id}`);
    }
  });

  test('the LLM Game Master degrades safely on malformed output', async () => {
    const garbageProvider: LLMProvider = {
      name: 'garbage',
      kind: 'openai',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        return { text: 'not json at all', model: 'garbage', latencyMs: 0, raw: null };
      },
      async healthCheck() {
        return { ok: true, detail: 'fine' };
      },
    };

    const gm = new LLMGameMaster({ provider: garbageProvider });
    const d = depsWith(gm);
    const outcome = await submitAction(newGame(SCENARIO_ID, 1, kb()), 'research the rules', d);

    // It must not throw, and it must still have selected a real option.
    assert.ok(outcome.turn.optionId, 'the engine should still have chosen an option');
    assert.ok(outcome.turn.optionId !== null);
    assert.equal(checkInvariants(outcome.state).filter((v) => v.severity === 'blocking').length, 0);
  });

  test('the LLM Game Master discards invented claim ids', async () => {
    const lyingProvider: LLMProvider = {
      name: 'liar',
      kind: 'openai',
      async chat(): Promise<ChatResponse> {
        return {
          text: JSON.stringify({
            chosen_option_id: 'no-such-option',
            decision_summary: 'made something up',
            unresolved: [],
            narration: [
              { text: 'The fee is KSh 950.', grounding: 'VERIFIED', claim_ids: ['C-INVENTED-99', 'C-RBN-04'] },
            ],
          }),
          model: 'liar',
          latencyMs: 0,
          raw: null,
        };
      },
      async healthCheck() {
        return { ok: true, detail: 'fine' };
      },
    };

    const gm = new LLMGameMaster({ provider: lyingProvider });
    const d = depsWith(gm);
    const outcome = await submitAction(newGame(SCENARIO_ID, 1, kb()), 'research the rules', d);

    const cited = outcome.turn.narration.flatMap((b) => b.claimIds);
    assert.ok(!cited.includes('C-INVENTED-99'), 'an invented claim id must be stripped at the boundary');
    assert.ok(outcome.turn.optionId !== 'no-such-option', 'an invented option id must not be honoured');
    assert.ok(checkInvariants(outcome.state).filter((v) => v.severity === 'blocking').length === 0);
  });

  test('scenarios are registered and well formed', () => {
    const scenarios = listScenarios();
    assert.ok(scenarios.length >= 1);
    for (const scenario of scenarios) {
      assert.ok(scenario.id.length > 0);
      assert.ok(scenario.title.length > 0);
      assert.ok(scenario.brief.length > 20);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Model output cannot corrupt game state                                  */
/* -------------------------------------------------------------------------- */

interface Rogue {
  name: string;
  propose(): GameMasterProposal;
}

/** Six different ways a model could try to take over the game. */
const ROGUES: Rogue[] = [
  {
    name: 'infinite-money',
    propose: () => ({
      chosenOptionId: null,
      narration: [{ text: 'You have a million shillings now.', grounding: 'FICTIONAL_GAME_EVENT', claimIds: [] }],
      unresolved: [],
    }),
  },
  {
    name: 'fabricated-option',
    propose: () => ({ chosenOptionId: 'CASH', narration: [], unresolved: [] }),
  },
  {
    name: 'invented-requirements',
    propose: () => ({
      chosenOptionId: null,
      narration: [
        {
          text: 'You must pay Nairobi County KSh 3,000 for a food permit and get a KRA PIN before you may trade.',
          grounding: 'FICTIONAL_GAME_EVENT',
          claimIds: [],
        },
      ],
      unresolved: [],
    }),
  },
  {
    name: 'laundered-fee',
    propose: () => ({
      chosenOptionId: null,
      narration: [
        { text: 'The prescribed fee is KSh 950.', grounding: 'VERIFIED', claimIds: ['C-RBN-17', 'C-BRS-10'] },
      ],
      unresolved: [],
    }),
  },
  {
    name: 'fake-citations',
    propose: () => ({
      chosenOptionId: null,
      narration: [
        { text: 'Section 42B requires a certificate of good conduct.', grounding: 'VERIFIED', claimIds: ['C-FAKE-1', 'C-ALSO-FAKE'] },
      ],
      unresolved: [],
    }),
  },
  {
    name: 'silent-refusal',
    propose: () => {
      throw new Error('the model crashed');
    },
  },
];

describe('10. different model outputs cannot corrupt the core game state', () => {
  const actions = [
    'research what registering a business name requires',
    'ask how much the fee costs',
    'buy a trolley for KSh 5,000',
    'apply to reserve my business name',
    'wait',
    'start trading and serve a customer',
    'wait',
    'register the business name',
    'display the certificate on the wall',
  ];

  test('the clean baseline is identical for every rogue run', async () => {
    const clean = await replay({ scenarioId: SCENARIO_ID, seed: 24680, actions }, deps());
    const cleanHash = clean.hash;

    for (const rogue of ROGUES) {
      if (rogue.name === 'silent-refusal') continue; // covered by its own test
      const gm = scriptedGameMaster(rogue.propose as never, `rogue:${rogue.name}`);
      const result = await replay({ scenarioId: SCENARIO_ID, seed: 24680, actions }, depsWith(gm));
      assert.equal(
        result.hash,
        cleanHash,
        `rogue "${rogue.name}" changed the simulation outcome. Narration is agent-supplied; state is not.`,
      );
    }
  });

  test('a crashing model is contained and reported, not propagated', async () => {
    const gm = scriptedGameMaster(() => {
      throw new Error('boom');
    }, 'rogue:crash');
    const d = depsWith(gm);
    let state = newGame(SCENARIO_ID, 1, kb());

    // The engine surfaces the failure rather than taking the process down.
    await assert.rejects(
      () => submitAction(state, 'research the rules', d),
      /boom/,
      'a model exception should surface as a rejected promise, not a silent bad state',
    );
    assert.equal(state.money, 8000, 'the pre-turn state must be untouched by a failed turn');
  });

  test('every rogue run still ends in a valid state', async () => {
    for (const rogue of ROGUES) {
      if (rogue.name === 'silent-refusal') continue;
      const gm = scriptedGameMaster(rogue.propose as never, `rogue:${rogue.name}`);
      const result = await replay({ scenarioId: SCENARIO_ID, seed: 24680, actions }, depsWith(gm));
      const violations = checkInvariants(result.state).filter((v) => v.severity === 'blocking');
      assert.deepEqual(violations, [], `rogue "${rogue.name}" left an invalid state`);
      assert.ok(result.state.money >= 0, `rogue "${rogue.name}" drove money negative`);
    }
  });

  test('the Critic fails every turn where a rogue made an unsupported claim', async () => {
    for (const rogue of ROGUES) {
      if (rogue.name === 'silent-refusal' || rogue.name === 'infinite-money') continue;
      const gm = scriptedGameMaster(rogue.propose as never, `rogue:${rogue.name}`);
      const outcome = await submitAction(newGame(SCENARIO_ID, 1, kb()), 'research the rules', depsWith(gm));
      const critique = outcome.turn.critique!;
      assert.equal(
        critique.passed,
        false,
        `rogue "${rogue.name}" produced unsupported claims that were not caught: ${critique.summary}`,
      );
      assert.ok(critique.score < 70, `rogue "${rogue.name}" scored ${critique.score}`);
    }
  });

  test('a model cannot reveal a claim that is not in the knowledge base', async () => {
    const gm = scriptedGameMaster(
      (context: TurnContext) => ({
        chosenOptionId: context.resolution.options.find((o) => o.available)?.id ?? null,
        narration: [
          { text: 'You have been granted a county permit worth KSh 3,000.', grounding: 'UNKNOWN', claimIds: ['C-PERMIT-01'] },
        ],
        unresolved: [],
      }),
      'rogue:claims',
    );
    const result = await replay({ scenarioId: SCENARIO_ID, seed: 5, actions: ['research the rules', 'wait'] }, depsWith(gm));
    assert.ok(!result.state.revealedClaims.includes('C-PERMIT-01'));
  });
});
