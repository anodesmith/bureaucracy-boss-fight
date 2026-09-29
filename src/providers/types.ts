/**
 * The provider interface.
 *
 * One narrow method: `chat`. Everything else - prompt construction, JSON
 * extraction, validation - lives above this line, so a new backend is a single
 * small file and cannot change how the agents reason.
 *
 * Note what is NOT here: there is no tool-calling interface, no state access,
 * and no way to run code. A model is a text function in this system. That is
 * deliberate and it is what makes test #10 ("different model outputs cannot
 * corrupt the core game state") true by construction.
 */

export interface ChatRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  latencyMs: number;
  /** Raw provider payload, retained for Lab Mode debugging. */
  raw: unknown;
}

export interface HealthReport {
  ok: boolean;
  detail: string;
  model?: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly kind: 'demo' | 'openai' | 'ollama';
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<HealthReport>;
}

export class ProviderError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, provider: string, cause?: unknown) {
    super(`${message} [provider: ${provider}]`);
    this.name = 'ProviderError';
    this.cause = cause;
  }
}

/**
 * Pull a JSON value out of a model response.
 *
 * Models wrap JSON in prose, in code fences, and in both. This scanner finds
 * the first balanced object or array, respecting strings and escapes, rather
 * than using a regex, because a regex will happily cut a string in half.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  const direct = tryParse(candidate);
  if (direct.ok) return direct.value;

  for (const { open, close } of [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
  ]) {
    const start = candidate.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          const attempt = tryParse(slice);
          if (attempt.ok) return attempt.value;
        }
      }
    }
  }
  throw new ProviderError('no parseable JSON found in model output', 'json', text.slice(0, 400));
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
