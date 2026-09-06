import type { ModelInfo, EffortLevel } from '../../shared/types.js';

export interface OpenRouterConfig {
  apiKey: string;
}

export interface ChatOptions {
  effortLevel?: EffortLevel;
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private apiKey: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://github.com/philaser/db-chat',
          'X-OpenRouter-Title': 'DB Chat'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
      if (json.data) {
        return json.data.map((model) => ({ id: model.id, name: model.name ?? model.id }));
      }
    } catch {
      // Fallback
    }
    return [
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
    ];
  }

  async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/philaser/db-chat',
        'X-OpenRouter-Title': 'DB Chat'
      },
      body: JSON.stringify({
        model: options.model,
        // OpenRouter SDK ChatRequestReasoning supports our effort values verbatim.
        reasoning: options.effortLevel ? { effort: options.effortLevel } : undefined,
        messages: options.messages,
        tools: options.tools,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
        stream_options: { include_usage: true }
      }),
      signal: options.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error('The provider stream ended before completion.');

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; }
          catch { throw new Error('The provider returned malformed stream data.'); }
          if (chunk.error) throw new Error('The provider reported a streaming error.');
          yield this.parseChunk(chunk);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private parseChunk(chunk: Record<string, unknown>): StreamChunk {
    const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0] ?? {};
    const delta = choice.delta as Record<string, unknown> | undefined;

    return {
      content: delta?.content as string | undefined,
      reasoning: delta?.reasoning_content as string | undefined,
      toolCalls: delta?.tool_calls as ToolCallDelta[] | undefined,
      finishReason: choice.finish_reason as string | undefined
    };
  }
}
