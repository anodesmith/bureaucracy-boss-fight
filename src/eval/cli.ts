/**
 * Evaluation CLI. `npm run eval`
 *
 * Prints a readable report. `--json` writes a machine-readable one to
 * `eval/reports/`. `--matrix` additionally runs the same episodes through any
 * configured LLM provider so demo and model results can be compared directly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRuntime } from '../server/runtime.js';
import { runEvaluation } from './harness.js';
import type { EvalReport } from './harness.js';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const matrix = args.has('--matrix');

function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return ''.padEnd(width, '.');
  const filled = Math.round((value / max) * width);
  return '#'.repeat(Math.max(0, Math.min(width, filled))).padEnd(width, '.');
}

function print(report: EvalReport): void {
  const line = '='.repeat(74);
  console.log(`\n${line}`);
  console.log('  BUREAUCRACY BOSS FIGHT - EVALUATION REPORT');
  console.log(line);
  console.log(`  generated   ${report.generatedAt}`);
  console.log(`  mode        ${report.mode} (${report.provider})`);
  console.log(
    `  knowledge   ${report.knowledge.documents} documents, ${report.knowledge.claims} claims, ${report.knowledge.defects} parser warnings`,
  );

  console.log(`\n${'-'.repeat(74)}\n  1. NORMAL PLAY`);
  console.log(`${'-'.repeat(74)}`);
  console.log(
    `  ${'episode'.padEnd(16)}${'turns'.padStart(6)}${'critic'.padStart(8)}${'pass%'.padStart(8)}${'unsup'.padStart(7)}${'invent'.padStart(8)}${'contra'.padStart(8)}${'endings'}`,
  );
  for (const episode of report.episodes) {
    const endings = Object.entries(episode.endings)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(
      `  ${episode.name.padEnd(16)}${String(episode.turns).padStart(6)}${String(episode.meanCriticScore).padStart(8)}${(episode.criticPassRate * 100).toFixed(0).padStart(7)}%${String(episode.unsupportedClaims).padStart(7)}${String(episode.inventedRequirements).padStart(8)}${String(episode.contradictions).padStart(8)}  ${endings}`,
    );
  }

  const mix: Record<string, number> = {};
  for (const episode of report.episodes) {
    for (const [k, v] of Object.entries(episode.groundingMix)) mix[k] = (mix[k] ?? 0) + v;
  }
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0);
  console.log(`\n  Grounding labels used across all narration:`);
  for (const [label, count] of Object.entries(mix).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${label.padEnd(24)}${String(count).padStart(5)}  ${bar(count, mixTotal)}`);
  }
  console.log(
    `    A healthy mix is mostly FICTIONAL_GAME_EVENT with a meaningful minority of VERIFIED\n` +
      `    and a non-zero number of UNKNOWN. Zero UNKNOWN would mean the game had stopped\n` +
      `    admitting what it does not know, which is the failure this project exists to avoid.`,
  );

  console.log(`\n${'-'.repeat(74)}\n  2. DETERMINISM`);
  console.log(`${'-'.repeat(74)}`);
  console.log(`  runs replayed                     ${report.determinism.runs}`);
  console.log(`  replay hash == live hash         ${report.determinism.identicalOnReplay}/${report.determinism.runs}`);
  console.log(`  repeat run == first run          ${report.determinism.identicalAcrossRepeat}/${report.determinism.runs}`);
  console.log(`  all deterministic                 ${report.determinism.allDeterministic ? 'YES' : 'NO'}`);

  console.log(`\n${'-'.repeat(74)}\n  3. ADVERSARIAL GAME MASTERS`);
  console.log(`${'-'.repeat(74)}`);
  console.log(
    `  ${'adversary'.padEnd(16)}${'detected'.padStart(14)}${'state==clean'.padStart(14)}${'damage'.padStart(10)}`,
  );
  for (const a of report.adversarial) {
    console.log(
      `  ${a.name.padEnd(16)}${`${a.turnsFailedCritic}/${a.turnsTested}`.padStart(14)}${(a.stateHashMatchesCleanRun ? 'yes' : 'NO').padStart(14)}${(a.anyStateDamage ? 'YES' : 'none').padStart(10)}`,
    );
  }

  console.log(`\n${'-'.repeat(74)}\n  VERDICT`);
  console.log(`${'-'.repeat(74)}`);
  console.log(`  ${report.summary.verdict}`);
  console.log(`\n  grounding violations in normal play   ${report.summary.groundingViolationsInNormalPlay}`);
  console.log(`  adversarial detection rate             ${report.summary.adversarialDetectionRate}`);
  console.log(`  state protected from all adversaries   ${report.summary.stateProtectedAgainstAllAdversaries}`);
  console.log(`\n  ${report.summary.groundTruth}\n`);
}

async function main(): Promise<void> {
  const runtime = createRuntime();

  if (matrix) {
    if (runtime.mode === 'demo') {
      console.log(
        '\n  --matrix needs a live provider. Set PROVIDER=openai with API_KEY,\n' +
          '  or PROVIDER=ollama with a running Ollama. Running demo-only matrix.\n',
      );
    } else {
      console.log(`\n  Running evaluation against live provider: ${runtime.provider?.name}\n`);
    }
  }

  const report = await runEvaluation(runtime);
  print(report);

  if (asJson) {
    const dir = resolve(process.cwd(), 'eval/reports');
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `report-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`  Machine-readable report written to ${file}\n`);
  }

  if (report.summary.groundingViolationsInNormalPlay !== 0) {
    process.exitCode = 1;
  }
}

void main();
