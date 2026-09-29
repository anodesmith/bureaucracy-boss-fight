/**
 * Manual smoke test. `npx tsx src/scripts/smoke.ts`
 * Plays a scripted run and prints it, so you can eyeball the game without
 * opening a browser.
 */

import { resolve } from 'node:path';
import { loadKnowledge } from '../agents/evidence/knowledge.js';
import { EvidenceAgent } from '../agents/evidence/index.js';
import { DemoGameMaster } from '../agents/game_master/demo.js';
import { CriticAgent } from '../agents/critic/index.js';
import { listScenarios, newGame, submitAction } from '../game/engine.js';
import { nairobiFood } from '../game/scenarios/nairobi-food.js';
import { stateHash } from '../core/hash.js';

const kb = loadKnowledge(resolve(process.cwd(), 'knowledge'));
const evidence = new EvidenceAgent(kb);
const deps = {
  kb,
  evidence,
  gameMaster: new DemoGameMaster(),
  critic: new CriticAgent(evidence),
};

const SCRIPT = [
  'research what registering a business name in Kenya actually requires',
  'ask how much the registration fee costs',
  'buy a trolley for KSh 5,000',
  'apply to reserve my business name',
  'wait for the registrar',
  'research how long I have to register after starting to trade',
  'buy ingredients for KSh 1,200',
  'start trading and serve a customer',
  'wait',
  'wait',
  'register the business name',
  'display the certificate on the wall',
  'wait',
  'wait',
];

async function main(): Promise<void> {
  const scenarioId = listScenarios()[0]!.id;
  let state = newGame(scenarioId, 20260929, kb);

  console.log('\n' + '='.repeat(78));
  console.log(`  ${nairobiFood.title.toUpperCase()}`);
  console.log(`  ${nairobiFood.subtitle}`);
  console.log('='.repeat(78) + '\n');

  for (const block of new DemoGameMaster().opening({
    title: nairobiFood.title,
    brief: nairobiFood.brief,
    objectives: nairobiFood.objectives,
  })) {
    console.log(block.text + '\n');
  }

  console.log(`Objectives:`);
  for (const obj of nairobiFood.objectives) {
    console.log(`  - ${obj.title}: ${obj.description}`);
  }
  console.log('');

  for (const action of SCRIPT) {
    const outcome = await submitAction(state, action, deps);
    state = outcome.state;

    console.log('-'.repeat(78));
    console.log(`PLAYER: ${action}`);
    console.log(`  parsed: ${outcome.turn.intent.type} (confidence ${outcome.turn.intent.confidence.toFixed(2)}) | option: ${outcome.turn.optionId ?? 'none'}`);
    for (const block of outcome.turn.narration) {
      const badge =
        block.grounding === 'VERIFIED'
          ? '[VERIFIED]'
          : block.grounding === 'INFERRED'
            ? '[INFERRED]'
            : block.grounding === 'UNKNOWN'
              ? '[UNKNOWN]'
              : '[SIM]';
      console.log(`  ${badge} ${block.text}`);
      if (block.claimIds.length > 0) console.log(`           cites: ${block.claimIds.join(', ')}`);
    }
    for (const event of outcome.turn.events) {
      console.log(`  (${event.kind}) ${event.title}: ${event.body}`);
    }
    const critique = outcome.turn.critique;
    if (critique) {
      console.log(
        `  CRITIC: score ${critique.score} ${critique.passed ? 'PASS' : 'FAIL'} - ${critique.summary}`,
      );
    }
    console.log(
      `  STATE: turn ${state.turn}/${state.maxTurns} | day ${state.day} | money KSh ${state.money} | claims known ${state.revealedClaims.length}`,
    );
    if (state.status !== 'ACTIVE') {
      console.log(`  STATUS: ${state.status}`);
    }
    console.log('');
  }

  console.log('='.repeat(78));
  if (state.ending) {
    console.log(`ENDING: ${state.ending.title} (grade ${state.ending.grade})`);
    console.log(`        ${state.ending.blurb}`);
  }
  console.log('OBJECTIVES:');
  for (const obj of state.objectives) {
    console.log(`  ${obj.status.padEnd(9)} ${obj.title}`);
  }
  console.log(`\nState hash: ${stateHash(state)}`);

  const audit = deps.critic.auditRun(state.log);
  console.log(
    `\nRUN AUDIT: ${audit.passed}/${audit.turns} turns passed, mean critic score ${audit.meanScore}`,
  );
  console.log(`  unsupported claims: ${audit.totalUnsupportedClaims}`);
  console.log(`  invented requirements: ${audit.totalInventedRequirements}`);
  console.log(`  contradictions: ${audit.totalContradictions}`);
  console.log(`  grounding labels used: ${JSON.stringify(audit.groundingsUsed)}`);
  console.log('');
}

void main();
