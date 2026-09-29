/**
 * Shared test fixtures.
 *
 * The knowledge base is loaded from disk exactly once. If a test needs a
 * synthetic knowledge base it should build one explicitly rather than mutating
 * the real one, so that a broken fixture can never make the real grounding
 * guarantees look weaker than they are.
 */

import { resolve } from 'node:path';
import { loadKnowledge, type KnowledgeBase } from '../src/agents/evidence/knowledge.js';
import { EvidenceAgent } from '../src/agents/evidence/index.js';
import { DemoGameMaster } from '../src/agents/game_master/demo.js';
import { CriticAgent } from '../src/agents/critic/index.js';
import type { GameMaster } from '../src/agents/game_master/types.js';
import type { GameDeps } from '../src/game/engine.js';

export const KNOWLEDGE_DIR = resolve(process.cwd(), 'knowledge');
export const SCENARIO_ID = 'mission-001-umoja-food-point';

let cached: KnowledgeBase | null = null;

export function kb(): KnowledgeBase {
  if (!cached) cached = loadKnowledge(KNOWLEDGE_DIR);
  return cached;
}

export function evidence(): EvidenceAgent {
  return new EvidenceAgent(kb());
}

export function deps(overrides: Partial<GameDeps> = {}): GameDeps {
  const agent = evidence();
  return {
    kb: kb(),
    evidence: agent,
    gameMaster: new DemoGameMaster(),
    critic: new CriticAgent(agent),
    ...overrides,
  };
}

export function depsWith(gameMaster: GameMaster): GameDeps {
  return deps({ gameMaster });
}

/** A Game Master that does whatever it is told, to test the guard rails. */
export function scriptedGameMaster(
  propose: GameMaster['propose'],
  name = 'scripted',
): GameMaster {
  return {
    name,
    opening: () => [],
    propose,
  };
}
