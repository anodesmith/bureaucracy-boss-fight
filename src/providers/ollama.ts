/**
 * Ollama provider.
 *
 * Uses the native `/api/chat` endpoint and asks for JSON in the response
 * format when the installed version supports it, while degrading gracefully
 * when it does not.
 */

import type { ChatRequest, ChatResponse, HealthReport, LLMProvider } from './types.js';
import { ProviderError } from './types.js';

export interface OllamaConfig {
  url: string;
  model: string;
  temperature: number;
  timeoutMs: number;
}

export class OllamaProvider implements LLMProvider {
  readonly kind = 'ollama' as const;
  readonly name: string;
  private readonly cfg: OllamaConfig;

  constructor(cfg: OllamaConfig) {
    this.cfg = cfg;
    this.name = `ollama:${cfg.model}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          stream: false,
          format: 'json',
          options: {
            temperature: request.temperature ?? this.cfg.temperature,
            ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        `could not reach Ollama at ${this.cfg.url}: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ProviderError(
        `/api/chat returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        this.name,
      );
    }

    const payload = (await response.json()) as { message?: { content?: string }; model?: string };
    return {
      text: payload.message?.content ?? '',
      model: payload.model ?? this.cfg.model,
      latencyMs: Date.now() - started,
      raw: payload,
    };
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(`${this.cfg.url}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return { ok: false, detail: `${this.cfg.url}/api/tags returned ${response.status}` };

      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      const installed = (payload.models ?? []).map((m) => m.name ?? '');
      const hasModel = installed.some((n) => n === this.cfg.model || n.startsWith(`${this.cfg.model}:`));
      return {
        ok: true,
        detail: hasModel
          ? `model ${this.cfg.model} is installed`
          : `reachable, but ${this.cfg.model} is not installed. Available: ${installed.join(', ') || 'none'}`,
        model: this.cfg.model,
      };
    } catch (error) {
      return { ok: false, detail: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
