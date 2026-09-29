/**
 * OpenAI-compatible chat provider.
 *
 * Deliberately one class covering the whole family, because they really are one
 * wire format: OpenAI, OpenRouter, Groq, Together, Fireworks, LM Studio, vLLM,
 * llama.cpp's server, and most gateways speak `/v1/chat/completions` and honour
 * the same body. Only `baseUrl` and `model` change.
 *
 * Authentication is optional: local servers generally ignore or omit it, and
 * sending an empty `Authorization` header to them is worse than sending none.
 */

import type { ChatRequest, ChatResponse, HealthReport, LLMProvider } from './types.js';
import { ProviderError } from './types.js';

export interface OpenAICompatibleConfig {
  name?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** Optional OpenRouter-style attribution headers. Ignored elsewhere. */
  appReference?: string;
  appTitle?: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly kind = 'openai' as const;
  readonly name: string;
  private readonly cfg: OpenAICompatibleConfig;

  constructor(cfg: OpenAICompatibleConfig) {
    this.cfg = cfg;
    this.name = cfg.name ?? `openai:${cfg.model}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.appReference) {
      headers['HTTP-Referer'] = this.cfg.appReference;
      headers['X-Title'] = this.cfg.appTitle ?? this.cfg.appReference;
    }
    return headers;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const url = `${this.cfg.baseUrl}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: request.temperature ?? this.cfg.temperature,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `${url} returned ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        this.name,
      );
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? '';

    return {
      text,
      model: payload.model ?? this.cfg.model,
      latencyMs: Date.now() - started,
      raw: payload,
    };
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.cfg.baseUrl}/models`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        return { ok: false, detail: `${this.cfg.baseUrl}/models returned ${response.status}` };
      }
      return { ok: true, detail: `reachable, default model ${this.cfg.model}`, model: this.cfg.model };
    } catch (error) {
      return {
        ok: false,
        detail: `unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
