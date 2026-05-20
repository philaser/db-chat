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

const openRouterFallbackModels: ModelInfo[] = [
  { id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1 Mini' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5' }
];

async function listOpenRouterModels(apiKey?: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${normalizeApiKey(apiKey)}`;
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed (${response.status})`);
  }

  const payload = await response.json() as {
    data?: Array<{
      id?: string;
      name?: string;
    }>;
  };

  return (payload.data ?? [])
    .filter((model): model is { id: string; name?: string } => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({
      id: model.id,
      name: model.name?.trim() || model.id
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const openRouterProvider: ModelProvider = {
  kind: 'openrouter',
  defaultModel: 'openai/gpt-4.1-mini',
  async listModels(apiKey?: string): Promise<ModelInfo[]> {
    try {
      const models = await listOpenRouterModels(apiKey);
      return models.length ? models : openRouterFallbackModels;
    } catch {
      return openRouterFallbackModels;
    }
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
