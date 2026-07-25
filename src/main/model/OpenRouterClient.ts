import { OpenRouter } from '@openrouter/sdk';
import type { ModelInfo } from '../../shared/types';

export interface OpenRouterConfig {
  apiKey: string;
}

export interface ChatOptions {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  temperature?: number;
  maxTokens?: number;
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

export class OpenRouterClient {
  private client: OpenRouter;

  constructor(config: OpenRouterConfig) {
    this.client = new OpenRouter({
      apiKey: config.apiKey,
      httpReferer: 'https://github.com/philaser/db-chat',
      appTitle: 'DB Chat'
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((model) => ({
        id: model.id,
        name: model.name ?? model.id
      }));
    } catch {
      return [
        { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
      ];
    }
  }

  async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    const stream = await this.client.chat.stream({
      model: options.model,
      messages: options.messages as Array<{ role: string; content: string }>,
      tools: options.tools as Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> | undefined,
      temperature: options.temperature,
      max_tokens: options.maxTokens
    });

    for await (const chunk of stream) {
      yield this.parseChunk(chunk as Record<string, unknown>);
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
