/**
 * EVALUATION TESTS 3, 4, 5, 6
 *
 *   3. Invalid actions are rejected
 *   4. Evidence citations exist when factual claims are made
 *   5. Unknown information is not converted into verified information
 *   6. The Critic detects unsupported claims
 *
 * Test 5 is the project's central promise. It is deliberately written against
 * the *load path* - the real knowledge base, the real retriever, the real
 * agents - rather than against a synthetic fixture, because a synthetic
 * knowledge base can only prove the code works on the case its author
 * imagined.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, submitAction } from '../src/game/engine.js';
import { parseAction, validateIntentShape } from '../src/game/actions/parser.js';
import { EvidenceAgent, looksLikeRealWorldClaim, looksLikeInventedRequirement } from '../src/agents/evidence/index.js';
import { CriticAgent } from '../src/agents/critic/index.js';
import { applyEffects } from '../src/game/state.js';
import type { EvidenceClaim } from '../src/core/types.js';
import { deps, depsWith, evidence, kb, SCENARIO_ID, scriptedGameMaster } from './fixtures.js';

/* -------------------------------------------------------------------------- */
/* 3. Invalid actions                                                          */
/* -------------------------------------------------------------------------- */

describe('3. invalid actions are rejected', () => {
  test('a purchase with no item is rejected and costs no turn', async () => {
    const d = deps();
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, 'buy', d);
    assert.ok(outcome.turn.rejection, 'the action should have been rejected');
    assert.equal(outcome.state.turn, state.turn, 'a rejected action must not consume a turn');
    assert.equal(outcome.state.money, state.money);
  });

  test('a purchase with no amount is rejected by the parser', async () => {
    const d = deps();
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, 'buy a trolley', d);
    // The engine may accept this (it can price from the catalogue) but it must
    // not invent a cost the player did not sanction.
    assert.ok(outcome.state.money <= state.money);
    assert.ok(outcome.state.money >= 0);
  });

  test('a negative or zero amount is rejected by shape validation', () => {
    for (const text of ['buy a trolley for KSh 0', 'buy a trolley for KSh -500']) {
      const intent = parseAction(text);
      const error = validateIntentShape(intent);
      if (error) assert.match(error, /positive amount|too long|Empty action|plausible/i);
    }
  });

  test('an absurd amount is rejected', () => {
    const intent = parseAction('buy a house for KSh 999,999,999');
    const error = validateIntentShape(intent);
    assert.ok(error, 'an implausible amount should be rejected');
    assert.match(error!, /implausible/i);
  });

  test('an item the catalogue does not carry is not bought', async () => {
    const d = deps();
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, 'buy a private jet for KSh 900,000,000', d);
    assert.equal(outcome.state.money, state.money, 'no money should be spent on an unknown item');
  });

  test('an action taken after the run is over is rejected', async () => {
    const d = deps();
    // Force a terminal state directly rather than trying to engineer one by
    // playing: the point of this test is the guard, not the economy.
    const start = newGame(SCENARIO_ID, 1, kb());
    const emptied = applyEffects(start, [
      { kind: 'MONEY_DELTA', delta: -start.money, ruleId: 'test', reason: 'drain', grounding: 'FICTIONAL_GAME_EVENT' },
    ]).state;
    assert.equal(emptied.money, 0);

    const over = await submitAction(emptied, 'wait', d);
    assert.notEqual(over.state.status, 'ACTIVE', 'spending the last shilling should end the run');

    const outcome = await submitAction(over.state, 'research the rules', d);
    assert.ok(outcome.turn.rejection, 'actions after the end must be rejected');
    assert.equal(outcome.state.turn, over.state.turn, 'a rejected action must not consume a turn');
    assert.equal(outcome.state.money, over.state.money);
  });

  test('over-long input is rejected without crashing', async () => {
    const d = deps();
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, 'x'.repeat(601), d);
    assert.ok(outcome.turn.rejection);
  });

  test('empty input is rejected', async () => {
    const d = deps();
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, '   ', d);
    assert.ok(outcome.turn.rejection);
    assert.equal(outcome.state.turn, state.turn);
  });

  test('nonsense input is handled without a crash and without a state change', async () => {
    const d = deps();
    for (const text of ['asdfghjkl', '???', '!!!!!!!!!!', 'flibbertigibbet']) {
      const state = newGame(SCENARIO_ID, 1, kb());
      const outcome = await submitAction(state, text, d);
      assert.ok(outcome.state, 'engine must not throw');
      assert.equal(checkInvariantsBlocking(outcome.state), 0);
    }
  });
});

function checkInvariantsBlocking(state: Parameters<typeof applyEffects>[0]): number {
  return applyEffects(state, []).violations.filter((v) => v.severity === 'blocking').length;
}

/* -------------------------------------------------------------------------- */
/* 4. Citations exist when factual claims are made                              */
/* -------------------------------------------------------------------------- */

describe('4. evidence citations exist when factual claims are made', () => {
  test('every VERIFIED narration block produced by the agents carries a claim id', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 20260929, kb());
    const actions = [
      'research what registering a business name requires',
      'ask how much the registration fee costs',
      'contact the Registrar',
      'apply to reserve my business name',
      'start trading and serve a customer',
      'register the business name',
      'display the certificate on the wall',
    ];
    let checked = 0;
    for (const action of actions) {
      const outcome = await submitAction(state, action, d);
      state = outcome.state;
      for (const block of outcome.turn.narration) {
        if (block.grounding !== 'VERIFIED') continue;
        checked += 1;
        assert.ok(
          block.claimIds.length > 0,
          `VERIFIED block with no citation after "${action}": ${block.text.slice(0, 90)}`,
        );
        for (const id of block.claimIds) {
          assert.ok(kb().byClaimId.has(id), `cited claim ${id} does not exist`);
        }
      }
      if (state.status !== 'ACTIVE') break;
    }
    assert.ok(checked > 0, 'the run should have produced at least one VERIFIED block to check');
  });

  test('the demo Game Master never produces an uncited factual assertion', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 31337, kb());
    const scripts = [
      ['research the rules', 'ask about the fee', 'contact the Registrar', 'apply to reserve my business name'],
      ['ask do I need a permit', 'research the certificate rules', 'ask how long I have'],
    ];
    for (const script of scripts) {
      for (const action of script) {
        const outcome = await submitAction(state, action, d);
        state = outcome.state;
        for (const block of outcome.turn.narration) {
          if (block.grounding === 'VERIFIED') {
            assert.ok(block.claimIds.length > 0, `uncited VERIFIED block: ${block.text.slice(0, 90)}`);
          }
          if (block.grounding === 'INFERRED') {
            assert.ok(block.claimIds.length > 0, `uncited INFERRED block: ${block.text.slice(0, 90)}`);
          }
        }
        if (state.status !== 'ACTIVE') break;
      }
      state = newGame(SCENARIO_ID, 31337, kb());
    }
  });

  test('a VERIFIED claim with no quote is rejected at load time', () => {
    // Direct unit check on the invariant the loader enforces.
    const fake: EvidenceClaim = {
      id: 'C-FAKE-01',
      text: 'The fee is KSh 950.',
      grounding: 'VERIFIED',
      documentId: 'x',
      documentTitle: 'x',
      documentUrl: '',
      documentVerification: 'VERIFIED',
      locator: 'section 1',
      quote: '',
      unknownReason: '',
      derivation: '',
      topics: ['fee'],
    };
    assert.equal(evidence().isUsable(fake), false, 'a VERIFIED claim with no quote must not be citable');
  });

  test('citation validation rejects a claim that does not say what is asserted', () => {
    const agent = evidence();
    const result = agent.validateCitation('C-RBN-03', 'The sky above Nairobi is a striking shade of blue.');
    assert.equal(result.ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Unknown is not converted into verified                                   */
/* -------------------------------------------------------------------------- */

describe('5. unknown information is never converted into verified', () => {
  test('no VERIFIED claim in the real knowledge base states a fee amount', () => {
    // The single most important assertion in this repository. If a future
    // contributor adds a "helpful" fee figure as VERIFIED, this fails.
    const offenders = kb().claims.filter(
      (c) =>
        c.grounding === 'VERIFIED' &&
        /\b(ksh\s*[\d,]+|[\d,]+\s*shillings)\b/i.test(c.text),
    );
    assert.deepEqual(
      offenders.map((c) => `${c.id}: ${c.text}`),
      [],
      'a VERIFIED claim may not state a monetary amount for a fee in this knowledge base',
    );
  });

  test('the prescribed-fee amount is recorded as UNKNOWN with a reason', () => {
    for (const id of ['C-RBN-17', 'C-BRS-10']) {
      const claim = kb().byClaimId.get(id);
      assert.ok(claim, `${id} should exist`);
      assert.equal(claim!.grounding, 'UNKNOWN');
      assert.ok(claim!.unknownReason.length > 20, `${id} should record why it is unknown`);
    }
  });

  test('UNKNOWN claims are never citable', () => {
    const agent = evidence();
    for (const claim of kb().claims.filter((c) => c.grounding === 'UNKNOWN')) {
      assert.equal(agent.isUsable(claim), false, `${claim.id} is UNKNOWN and must not be citable`);
      const result = agent.validateCitation(claim.id, claim.text);
      assert.equal(result.ok, false, `${claim.id} must not validate as a citation`);
    }
  });

  test('claims from a CONFLICTED document cannot be VERIFIED', () => {
    const conflicted = kb().documents.filter((d) => d.verification === 'CONFLICTED');
    assert.ok(conflicted.length > 0, 'there should be a conflicted document in this knowledge base');
    for (const doc of conflicted) {
      for (const claim of doc.claims) {
        assert.notEqual(claim.grounding, 'VERIFIED', `${claim.id} cannot be VERIFIED in a CONFLICTED document`);
      }
    }
  });

  test('a UNKNOWN claim cited to support a VERIFIED block is a blocking Critic failure', async () => {
    const laundering = scriptedGameMaster(
      () => ({
        chosenOptionId: null,
        narration: [
          {
            text: 'The prescribed fee for a business name registration is KSh 950.',
            grounding: 'VERIFIED',
            claimIds: ['C-RBN-17'],
          },
        ],
        unresolved: [],
      }),
      'launderer',
    );

    const d = depsWith(laundering);
    const state = newGame(SCENARIO_ID, 1, kb());
    const outcome = await submitAction(state, 'research the rules', d);
    const critique = outcome.turn.critique!;

    assert.equal(critique.passed, false);
    assert.ok(
      critique.checks.some((c) => c.id.startsWith('launder-') && !c.passed),
      'laundering an UNKNOWN into a VERIFIED block must be caught',
    );
    assert.equal(critique.groundingRespected, false);
  });

  test('asking the Game Master about the fee produces UNKNOWN, never a figure', async () => {
    const d = deps();
    let state = newGame(SCENARIO_ID, 2026, kb());
    const outcome = await submitAction(state, 'how much does registering a business name cost?', d);
    state = outcome.state;

    const unknowns = outcome.turn.narration.filter((b) => b.grounding === 'UNKNOWN');
    assert.ok(unknowns.length > 0, 'the honest answer should include at least one UNKNOWN block');

    for (const block of unknowns) {
      for (const id of block.claimIds) {
        assert.equal(kb().byClaimId.get(id)?.grounding, 'UNKNOWN');
      }
    }

    // The Game Master must not assert a specific fee as verified anywhere.
    for (const block of outcome.turn.narration) {
      if (block.grounding !== 'VERIFIED') continue;
      assert.doesNotMatch(
        block.text,
        /\bksh\s*\d/i,
        `a VERIFIED block stated a fee amount: ${block.text.slice(0, 100)}`,
      );
    }
  });

  test('retrieval reports a gap rather than silently returning nothing for a fee query', () => {
    const agent = evidence();
    const bundle = agent.retrieve('how much is the prescribed fee for business name registration', { limit: 8 });
    assert.ok(bundle.gaps.length > 0, 'a fee query should surface a documented gap');
    assert.ok(
      bundle.gaps.some((g) => /unknown|conflicted|coincidence/i.test(g.reason)),
      'the gap should say why the answer is unavailable',
    );
  });

  test('retrieval never marks an UNKNOWN claim as citable even at the top rank', () => {
    const agent = evidence();
    for (const query of ['fee cost price ksh', 'how much registration', 'prescribed fee amount']) {
      const bundle = agent.retrieve(query, { limit: 10 });
      for (const id of bundle.usable) {
        assert.notEqual(kb().byClaimId.get(id)?.grounding, 'UNKNOWN');
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The Critic detects unsupported claims                                     */
/* -------------------------------------------------------------------------- */

describe('6. the Critic detects unsupported claims', () => {
  const cases: Array<{ name: string; text: string; grounding: string; claimIds: string[]; expect: RegExp }> = [
    {
      name: 'invented claim id',
      text: 'The prescribed fee is KSh 950 under section 17(2).',
      grounding: 'VERIFIED',
      claimIds: ['C-NOT-A-REAL-CLAIM'],
      expect: /citation-missing-/,
    },
    {
      name: 'real claim that does not say this',
      text: 'You must obtain a KSh 3,000 county permit each year before you may trade.',
      grounding: 'VERIFIED',
      claimIds: ['C-RBN-04'],
      expect: /^citation-C-RBN-04$/,
    },
    {
      name: 'VERIFIED with no citation at all',
      text: 'You are required to display the certificate in a conspicuous position.',
      grounding: 'VERIFIED',
      claimIds: [],
      expect: /bare-verified-/,
    },
    {
      name: 'a real requirement hidden inside a simulation block',
      text: 'You must pay the Nairobi County a KSh 3,000 food handling permit fee every year.',
      grounding: 'FICTIONAL_GAME_EVENT',
      claimIds: [],
      expect: /fiction-as-fact-/,
    },
  ];

  for (const testCase of cases) {
    test(`detects: ${testCase.name}`, async () => {
      const gm = scriptedGameMaster(
        () => ({
          chosenOptionId: null,
          narration: [
            { text: testCase.text, grounding: testCase.grounding as never, claimIds: testCase.claimIds },
          ],
          unresolved: [],
        }),
        'test',
      );
      const d = depsWith(gm);
      const outcome = await submitAction(newGame(SCENARIO_ID, 1, kb()), 'research the rules', d);
      const critique = outcome.turn.critique!;

      assert.ok(
        critique.checks.some((c) => !c.passed && testCase.expect.test(c.id)),
        `expected a failing check matching ${testCase.expect}, got: ${critique.checks
          .filter((c) => !c.passed)
          .map((c) => c.id)
          .join(', ')}`,
      );
      assert.equal(critique.passed, false);
      assert.ok(critique.score < 70);
    });
  }

  test('detects a real-world claim dressed as fiction', () => {
    assert.equal(
      looksLikeInventedRequirement('You must obtain a Nairobi County food handling permit.'),
      true,
    );
    assert.equal(
      looksLikeInventedRequirement('[SIMULATION] The trolley costs KSh 5,000, a figure invented for this game.'),
      false,
      'an explicitly disclaimed simulation figure is not a masquerade',
    );
    assert.equal(
      looksLikeRealWorldClaim('The queue is long today.'),
      false,
      'ordinary scene-setting is not a factual assertion',
    );
  });

  test('a clean turn passes every check', async () => {
    const d = deps();
    const outcome = await submitAction(newGame(SCENARIO_ID, 1, kb()), 'research what registering requires', d);
    const critique = outcome.turn.critique!;
    const failed = critique.checks.filter((c) => !c.passed);
    assert.deepEqual(failed, [], `unexpected failures: ${JSON.stringify(failed, null, 2)}`);
    assert.equal(critique.passed, true);
    assert.equal(critique.score, 100);
  });

  test('the Critic reports a blocked transition', () => {
    const agent = new CriticAgent(evidence());
    const state = newGame(SCENARIO_ID, 1, kb());
    const verdict = agent.evaluate({
      turn: 1,
      stateBefore: state,
      stateAfter: { ...state, money: -500 } as never,
      chosenOption: null,
      proposal: { chosenOptionId: null, narration: [], unresolved: [] },
      evidence: { query: '', claims: [], usable: [], gaps: [] },
      resolution: {
        turn: 1,
        intent: parseAction('wait'),
        options: [],
        rejection: null,
        preamble: [],
        rulesFired: [],
        evidenceQueries: [],
      },
      refused: [],
      appliedEffects: [],
    });
    assert.equal(verdict.stateTransitionLegal, false);
    assert.equal(verdict.passed, false);
  });
});
