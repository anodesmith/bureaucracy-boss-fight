/**
 * Provider factory.
 *
 * The game is fully playable with no configuration. `demo` is not a stub that
 * throws; it is a complete, deterministic Game Master that plays the scenario
 * properly. A fresh clone therefore needs no API key, no network, and no
 * `ollama pull`.
 */

import { loadConfig, type AppConfig, type ProviderKind } from './config.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { LLMProvider } from './types.js';
import { ProviderError } from './types.js';

export function createProvider(config: AppConfig = loadConfig()): LLMProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        appReference: config.appReference,
        appTitle: config.appTitle,
      });
    case 'ollama':
      return new OllamaProvider({
        url: config.ollamaUrl,
        model: config.ollamaModel,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
      });
    case 'demo':
    default:
      throw new ProviderError(
        'demo mode has no LLM provider; use DemoGameMaster directly',
        'demo',
      );
  }
}

/**
 * Build the provider, or fall back to demo mode with a clear reason.
 * Returns the reason so the UI can tell the player *why* they are in demo mode.
 */
export function createProviderOrDemo(config: AppConfig = loadConfig()): {
  provider: LLMProvider | null;
  kind: ProviderKind | 'demo';
  fallbackReason: string | null;
} {
  if (config.provider === 'demo') {
    return { provider: null, kind: 'demo', fallbackReason: null };
  }
  if (config.provider === 'openai' && config.apiKey === '' && !isLocalUrl(config.baseUrl)) {
    return {
      provider: null,
      kind: 'demo',
      fallbackReason: 'PROVIDER=openai but API_KEY is empty and BASE_URL is not a local server. Using demo mode.',
    };
  }
  try {
    return { provider: createProvider(config), kind: config.provider, fallbackReason: null };
  } catch (error) {
    return {
      provider: null,
      kind: 'demo',
      fallbackReason: `Could not initialise the ${config.provider} provider: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(url);
}

export { loadConfig } from './config.js';
export type { AppConfig, ProviderKind } from './config.js';
export * from './types.js';
