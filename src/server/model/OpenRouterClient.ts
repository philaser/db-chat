import type { ModelInfo, EffortLevel } from '../../shared/types.js';
import {
  assertSupportedModel,
  PROVIDER_BASE_URLS,
  type InferenceProvider
} from './providerConfig.js';

export interface OpenRouterConfig {
  apiKey: string;
  provider?: InferenceProvider;
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
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
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

export class OpenRouterClient {
  private apiKey: string;
  private provider: InferenceProvider;
  private readonly deepSeekReasoningByToolCall = new Map<string, string>();

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.provider = config.provider ?? 'openrouter';
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${PROVIDER_BASE_URLS[this.provider]}/models`, {
        headers: this.headers()
      });
      if (!response.ok) throw new Error(`${this.provider} API error (${response.status}).`);
      const json = (await response.json()) as { data?: Array<{ id: string; name?: string }> };
      if (json.data) {
        return json.data.map((model) => ({ id: model.id, name: model.name ?? model.id }));
      }
      throw new Error(`${this.provider} returned an invalid model list.`);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`${this.provider} model listing failed.`);
    }
  }

  async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    assertSupportedModel(this.provider, options.model);
    const response = await fetch(`${PROVIDER_BASE_URLS[this.provider]}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(options)),
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(`${this.provider} API error (${response.status}).`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let responseReasoning = '';
    const responseToolCallIds = new Map<number, string>();

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
          if (data === '[DONE]') {
            if (this.provider === 'deepseek' && responseReasoning) {
              for (const id of responseToolCallIds.values()) {
                this.deepSeekReasoningByToolCall.set(id, responseReasoning);
              }
            }
            return;
          }

          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; }
          catch { throw new Error('The provider returned malformed stream data.'); }
          if (chunk.error) throw new Error(`${this.provider} reported a streaming error.`);
          const parsed = this.parseChunk(chunk);
          if (this.provider === 'deepseek') {
            responseReasoning += parsed.reasoning ?? '';
            for (const toolCall of parsed.toolCalls ?? []) {
              if (toolCall.id) responseToolCallIds.set(toolCall.index, toolCall.id);
            }
          }
          yield parsed;
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
    const rawUsage = chunk.usage as Record<string, unknown> | undefined;
    const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

    return {
      content: delta?.content as string | undefined,
      reasoning: (delta?.reasoning_content ?? delta?.reasoning) as string | undefined,
      toolCalls: delta?.tool_calls as ToolCallDelta[] | undefined,
      finishReason: choice.finish_reason as string | undefined,
      usage: rawUsage ? {
        promptTokens: number(rawUsage.prompt_tokens),
        completionTokens: number(rawUsage.completion_tokens),
        totalTokens: number(rawUsage.total_tokens),
        costUsd: number(rawUsage.cost)
      } : undefined
    };
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.provider === 'openrouter' ? {
        'HTTP-Referer': 'https://github.com/philaser/db-chat',
        'X-OpenRouter-Title': 'DB Chat'
      } : {})
    };
  }

  private requestBody(options: ChatOptions): Record<string, unknown> {
    const messages = this.provider === 'deepseek' && this.deepSeekReasoningByToolCall.size
      ? this.withDeepSeekReasoning(options.messages)
      : options.messages;
    const common = {
      model: options.model,
      messages,
      tools: options.tools,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (this.provider === 'openrouter') {
      return {
        ...common,
        reasoning: options.effortLevel ? { effort: options.effortLevel } : undefined,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 4096
      };
    }
    if (this.provider === 'openai') {
      const reasoningEffort = options.effortLevel === 'max' ? 'xhigh' : options.effortLevel;
      return {
        ...common,
        reasoning_effort: reasoningEffort,
        max_completion_tokens: options.maxTokens ?? 4096
      };
    }

    const effort = options.effortLevel;
    const reasoningEffort = effort === 'max' ? 'max'
      : effort === 'low' ? 'low'
        : effort ? 'high' : undefined;
    return {
      ...common,
      thinking: effort ? { type: effort === 'none' ? 'disabled' : 'enabled' } : undefined,
      reasoning_effort: effort === 'none' ? undefined : reasoningEffort,
      temperature: effort === 'none' ? (options.temperature ?? 0.2) : undefined,
      max_tokens: options.maxTokens ?? 4096
    };
  }

  private withDeepSeekReasoning(messages: ChatOptions['messages']): ChatOptions['messages'] {
    return messages.map((message) => {
      if (message.role !== 'assistant' || !message.tool_calls?.length) return message;
      const ids = message.tool_calls.flatMap((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object') return [];
        const id = (toolCall as { id?: unknown }).id;
        return typeof id === 'string' ? [id] : [];
      });
      const reasoningContent = ids.map((id) => this.deepSeekReasoningByToolCall.get(id)).find(Boolean);
      return reasoningContent ? { ...message, reasoning_content: reasoningContent } : message;
    });
  }
}
