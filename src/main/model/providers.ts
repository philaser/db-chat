import type { ModelChatMessage, ModelChatOptions, ModelInfo, ModelProvider } from '../../shared/types.js';
import { normalizeApiKey } from './apiKeys.js';

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: ModelChatMessage[];
    temperature: number;
  };
}

export function buildOpenRouterRequest(messages: ModelChatMessage[], options: ModelChatOptions): ProviderRequest {
  const apiKey = normalizeApiKey(options.apiKey);
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://db-chat.local',
      'X-Title': 'DB Chat'
    },
    body: {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2
    }
  };
}

export function buildOpenAIRequest(messages: ModelChatMessage[], options: ModelChatOptions): ProviderRequest {
  const apiKey = normalizeApiKey(options.apiKey);
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: options.model,
      messages,
      temperature: options.temperature ?? 0.2
    }
  };
}

async function sendProviderRequest(request: ProviderRequest): Promise<string> {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Model request failed (${response.status}): ${details}`);
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Model response did not include assistant content.');
  }
  return content;
}

export const openRouterProvider: ModelProvider = {
  kind: 'openrouter',
  defaultModel: 'openai/gpt-4.1-mini',
  async listModels(_apiKey?: string): Promise<ModelInfo[]> {
    return [
      { id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1 Mini' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5' }
    ];
  },
  async sendChat(messages, options): Promise<string> {
    return sendProviderRequest(buildOpenRouterRequest(messages, options));
  }
};

export const openAIProvider: ModelProvider = {
  kind: 'openai',
  defaultModel: 'gpt-4.1-mini',
  async listModels(_apiKey?: string): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' }
    ];
  },
  async sendChat(messages, options): Promise<string> {
    return sendProviderRequest(buildOpenAIRequest(messages, options));
  }
};

export const modelProviders = {
  openrouter: openRouterProvider,
  openai: openAIProvider
} as const;
