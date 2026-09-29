/**
 * Configuration loading.
 *
 * No dotenv dependency. `.env` is parsed here if present, then overridden by
 * real environment variables, so CI and container deployments behave sensibly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ProviderKind = 'demo' | 'openai' | 'ollama';

export interface AppConfig {
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  ollamaUrl: string;
  ollamaModel: string;
  temperature: number;
  port: number;
  timeoutMs: number;
  appReference: string;
  appTitle: string;
}

/** Minimal `.env` reader. Ignores comments, blank lines and `export` prefixes. */
export function loadDotEnv(file = resolve(process.cwd(), '.env')): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function read(key: string, env: Record<string, string>, fallback = ''): string {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  return env[key] !== undefined && env[key] !== '' ? env[key] : fallback;
}

export function loadConfig(env: Record<string, string> = loadDotEnv()): AppConfig {
  const providerRaw = read('PROVIDER', env, 'demo').toLowerCase();
  const provider: ProviderKind =
    providerRaw === 'openai' || providerRaw === 'ollama' ? providerRaw : 'demo';

  return {
    provider,
    apiKey: read('API_KEY', env, ''),
    baseUrl: read('BASE_URL', env, 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: read('MODEL', env, 'gpt-4o-mini'),
    ollamaUrl: read('OLLAMA_URL', env, 'http://localhost:11434').replace(/\/+$/, ''),
    ollamaModel: read('OLLAMA_MODEL', env, 'llama3.1'),
    temperature: Number.parseFloat(read('TEMPERATURE', env, '0.2')) || 0.2,
    port: Number.parseInt(read('PORT', env, '3000'), 10) || 3000,
    timeoutMs: Number.parseInt(read('LLM_TIMEOUT_MS', env, '45000'), 10) || 45000,
    appReference: read('APP_REFERENCE', env, 'bureaucracy-boss-fight'),
    appTitle: read('APP_TITLE', env, 'Bureaucracy Boss Fight'),
  };
}
