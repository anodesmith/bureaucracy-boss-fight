/**
 * HTTP server and JSON API.
 *
 * Games live in memory. There is no account, no database and no persistence:
 * the interesting artefact is the engine, and adding a store would add failure
 * modes without adding anything this project is trying to demonstrate. A run
 * can be exported as a JSON transcript and replayed from its seed, which is
 * the durable form that actually matters here.
 */

import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRuntime, providerLabel, type Runtime } from './runtime.js';
import { loadConfig } from '../providers/index.js';
import {
  listScenarios,
  newGame,
  replay,
  submitAction,
  validate,
} from '../game/engine.js';
import { stateHash, digestState } from '../core/hash.js';
import type { TurnRecord } from '../core/types.js';
import { nairobiFood } from '../game/scenarios/nairobi-food.js';
import { runEvaluation } from '../eval/harness.js';

const runtime: Runtime = createRuntime();
const app = express();
app.use(express.json({ limit: '64kb' }));

/* -------------------------------------------------------------------------- */
/* Game store                                                                  */
/* -------------------------------------------------------------------------- */

interface Session {
  id: string;
  state: ReturnType<typeof newGame>;
  createdAt: number;
  seed: number;
  scenarioId: string;
  labVisible: boolean;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

function newSessionId(): string {
  sessionCounter += 1;
  return `g${sessionCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

/** State as the client needs it. */
function publicState(session: Session) {
  const { state } = session;
  return {
    id: session.id,
    scenarioId: session.scenarioId,
    seed: session.seed,
    turn: state.turn,
    maxTurns: state.maxTurns,
    day: state.day,
    money: state.money,
    status: state.status,
    ending: state.ending,
    inventory: state.inventory,
    flags: redactFlags(state.flags),
    objectives: state.objectives,
    revealedClaims: state.revealedClaims,
    digest: digestState(state),
    stateHash: stateHash(state),
  };
}

/**
 * The client gets the flags that drive the UI and nothing else. Internal
 * bookkeeping flags are not part of the game contract and leaking them would
 * invite clients to reason about engine internals.
 */
const VISIBLE_FLAGS = new Set(['nameSearchLodged', 'registered', 'displayed', 'tradingDay', 'ownNameRoute', 'registrationOverdue', 'feeQuoted', 'nameDecision']);

function redactFlags(flags: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (VISIBLE_FLAGS.has(key)) out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    mode: runtime.mode,
    provider: providerLabel(runtime),
    reason: runtime.modeReason,
    knowledge: {
      documents: runtime.kb.documents.length,
      claims: runtime.kb.claims.length,
      defects: runtime.kb.defects.filter((d) => d.severity === 'error').length,
    },
    scenarios: listScenarios().length,
  });
});

app.get('/api/scenarios', (_req: Request, res: Response) => {
  res.json({ scenarios: listScenarios() });
});

app.get('/api/knowledge/documents', (_req: Request, res: Response) => {
  res.json({
    documents: runtime.kb.documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      source: doc.source,
      sourceUrl: doc.sourceUrl,
      documentType: doc.documentType,
      jurisdiction: doc.jurisdiction,
      versionDate: doc.versionDate,
      retrievedAt: doc.retrievedAt,
      verification: doc.verification,
      verificationNote: doc.verificationNote,
      summary: doc.summary,
      claimCount: doc.claims.length,
      counts: doc.claims.reduce(
        (acc, claim) => {
          acc[claim.grounding] = (acc[claim.grounding] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    })),
  });
});

app.get('/api/knowledge/claims', (_req: Request, res: Response) => {
  const known = new Set<string>();
  for (const session of sessions.values()) {
    for (const id of session.state.revealedClaims) known.add(id);
  }
  res.json({ claims: runtime.kb.claims, discoveredGlobally: [...known] });
});

app.post('/api/game/new', (req: Request, res: Response) => {
  const scenarioId = typeof req.body?.scenarioId === 'string' ? req.body.scenarioId : nairobiFood.id;
  const seed =
    typeof req.body?.seed === 'number' && Number.isInteger(req.body.seed) && req.body.seed >= 0
      ? req.body.seed
      : Math.floor(Math.random() * 2_000_000_000);

  try {
    const state = newGame(scenarioId, seed, runtime.kb);
    const session: Session = {
      id: newSessionId(),
      state,
      createdAt: Date.now(),
      seed,
      scenarioId,
      labVisible: true,
    };
    sessions.set(session.id, session);
    res.json({
      session: publicState(session),
      opening: runtime.gameMaster.opening({
        title: nairobiFood.title,
        brief: nairobiFood.brief,
        objectives: nairobiFood.objectives.map((o) => ({ title: o.title, description: o.description })),
      }),
      actions: actionMenu(),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/game/:id', (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  res.json({
    session: publicState(session),
    transcript: session.state.log.map(publicTurn),
    validation: validate(session.state),
  });
});

app.post('/api/game/:id/action', async (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.length > 600) {
    res.status(400).json({ error: 'action text is too long' });
    return;
  }

  try {
    const outcome = await submitAction(session.state, text, runtime.deps);
    session.state = outcome.state;
    res.json({
      session: publicState(session),
      turn: publicTurn(outcome.turn),
      lab: session.labVisible ? outcome.lab : null,
      validation: validate(outcome.state),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      stack: process.env.NODE_ENV === 'production' ? undefined : String((error as Error)?.stack ?? ''),
    });
  }
});

app.post('/api/game/:id/lab', (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  session.labVisible = Boolean(req.body?.visible);
  res.json({ labVisible: session.labVisible });
});

app.post('/api/game/:id/replay', async (req: Request, res: Response) => {
  const session = requireSession(req, res);
  if (!session) return;
  const actions = session.state.log
    .map((record) => record.intent.text)
    .filter((t) => t.trim() !== '');

  const first = await replay({ scenarioId: session.scenarioId, seed: session.seed, actions }, runtime.deps);
  const second = await replay({ scenarioId: session.scenarioId, seed: session.seed, actions }, runtime.deps);
  res.json({
    originalHash: stateHash(session.state),
    replayHash: first.hash,
    replayHashAgain: second.hash,
    deterministic: first.hash === second.hash,
    matchesOriginal: first.hash === stateHash(session.state),
    turns: first.state.log.length,
  });
});

app.post('/api/eval', async (_req: Request, res: Response) => {
  try {
    const report = await runEvaluation(runtime);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function requireSession(req: Request, res: Response): Session | null {
  const session = getSession(req.params.id ?? '');
  if (!session) {
    res.status(404).json({ error: 'no such game' });
    return null;
  }
  return session;
}

/** Transcript record, trimmed for transport. */
function publicTurn(record: TurnRecord) {
  return {
    turn: record.turn,
    action: record.intent.text,
    actionType: record.intent.type,
    confidence: Number(record.intent.confidence.toFixed(2)),
    optionId: record.optionId,
    narration: record.narration,
    events: record.events,
    rejection: record.rejection,
    dayAfter: record.dayAfter,
    moneyAfter: record.moneyAfter,
    critique: record.critique
      ? {
          passed: record.critique.passed,
          score: record.critique.score,
          summary: record.critique.summary,
          checks: record.critique.checks,
          unsupportedClaims: record.critique.unsupportedClaims,
          inventedRequirements: record.critique.inventedRequirements,
          contradictions: record.critique.contradictions,
          stateTransitionLegal: record.critique.stateTransitionLegal,
          groundingRespected: record.critique.groundingRespected,
        }
      : null,
  };
}

function actionMenu(): Array<{ type: string; label: string; hint: string; example: string }> {
  return [
    { type: 'RESEARCH', label: 'Research', hint: 'Read a source', example: 'research how long I have to register' },
    { type: 'ASK', label: 'Ask', hint: 'Question the Game Master', example: 'ask how much the fee costs' },
    { type: 'BUY', label: 'Buy', hint: 'Spend money on something', example: 'buy a trolley for KSh 5,000' },
    { type: 'CONTACT', label: 'Contact', hint: 'Go to an authority', example: 'contact the Registrar' },
    { type: 'APPLY', label: 'Apply', hint: 'Lodge an application', example: 'apply to reserve my business name' },
    { type: 'TRAVEL', label: 'Travel', hint: 'Move around the city', example: 'travel to the Registrar' },
    { type: 'INSPECT', label: 'Inspect', hint: 'Examine something', example: 'inspect the market site' },
    { type: 'WAIT', label: 'Wait', hint: 'Let time pass', example: 'wait' },
    { type: 'CUSTOM', label: 'Custom', hint: 'Anything else', example: 'I put my savings into a SACCO account' },
  ];
}

/* -------------------------------------------------------------------------- */
/* Static                                                                      */
/* -------------------------------------------------------------------------- */

const publicDir = resolve(process.cwd(), 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(resolve(publicDir, 'index.html'));
  });
}

const config = loadConfig();
const port = process.env.PORT ? Number(process.env.PORT) : config.port;

app.listen(port, () => {
  const line = '='.repeat(66);
  console.log(`\n${line}`);
  console.log('  BUREAUCRACY BOSS FIGHT');
  console.log(line);
  console.log(`  http://localhost:${port}`);
  console.log(`  mode:     ${runtime.mode}  (${providerLabel(runtime)})`);
  if (runtime.modeReason) console.log(`  note:     ${runtime.modeReason}`);
  console.log(`  knowledge: ${runtime.kb.documents.length} documents, ${runtime.kb.claims.length} claims`);
  console.log(`  seed:      any integer, set it in the UI to replay a run exactly`);
  console.log(`${line}\n`);
});

export { app, runtime };
