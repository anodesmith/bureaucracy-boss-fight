/**
 * Runtime wiring.
 *
 * One place where the knowledge base, the agents and the provider are
 * assembled. The server, the evaluation harness and the tests all build their
 * dependencies through here so they cannot drift apart.
 */

import { resolve } from 'node:path';
import { loadKnowledge, type KnowledgeBase } from '../agents/evidence/knowledge.js';
import { EvidenceAgent } from '../agents/evidence/index.js';
import { DemoGameMaster } from '../agents/game_master/demo.js';
import { LLMGameMaster } from '../agents/game_master/llm.js';
import type { GameMaster } from '../agents/game_master/types.js';
import { CriticAgent } from '../agents/critic/index.js';
import { createProviderOrDemo, loadConfig, type AppConfig } from '../providers/index.js';
import type { LLMProvider } from '../providers/types.js';
import type { GameDeps } from '../game/engine.js';

export interface Runtime {
  config: AppConfig;
  kb: KnowledgeBase;
  evidence: EvidenceAgent;
  critic: CriticAgent;
  gameMaster: GameMaster;
  deps: GameDeps;
  provider: LLMProvider | null;
  mode: 'demo' | 'llm';
  modeReason: string | null;
  knowledgeDir: string;
}

export function createRuntime(config: AppConfig = loadConfig(), knowledgeDir = resolve(process.cwd(), 'knowledge')): Runtime {
  const kb = loadKnowledge(knowledgeDir);
  const evidence = new EvidenceAgent(kb);
  const critic = new CriticAgent(evidence);

  const { provider, kind, fallbackReason } = createProviderOrDemo(config);

  const gameMaster: GameMaster = provider
    ? new LLMGameMaster({
        provider,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
      })
    : new DemoGameMaster();

  return {
    config,
    kb,
    evidence,
    critic,
    gameMaster,
    provider,
    mode: provider ? 'llm' : 'demo',
    modeReason: fallbackReason,
    knowledgeDir,
    deps: { kb, evidence, gameMaster, critic },
  };
}

/** Provider label for display. */
export function providerLabel(runtime: Runtime): string {
  if (runtime.mode === 'demo') return 'demo (deterministic)';
  return runtime.provider?.name ?? 'unknown';
}
