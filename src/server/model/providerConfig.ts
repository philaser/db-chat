import type { ModelInfo } from '../../shared/types.js';

export type InferenceProvider = 'openrouter' | 'openai' | 'deepseek';
export type PersonalInferenceProvider = Exclude<InferenceProvider, 'openrouter'>;

export const PROVIDER_BASE_URLS: Readonly<Record<InferenceProvider, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1'
};

export const PERSONAL_PROVIDER_MODELS: Record<PersonalInferenceProvider, ModelInfo[]> = {
  openai: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }
  ],
  deepseek: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
  ]
};

export const DEFAULT_PERSONAL_PROVIDER_MODELS: Readonly<Record<PersonalInferenceProvider, string>> = {
  openai: 'gpt-5.6-terra',
  deepseek: 'deepseek-v4-flash'
};

export function isSupportedPersonalModel(provider: PersonalInferenceProvider, model: string): boolean {
  return PERSONAL_PROVIDER_MODELS[provider].some((candidate) => candidate.id === model);
}

export function assertSupportedModel(provider: InferenceProvider, model: string): void {
  if (provider !== 'openrouter' && !isSupportedPersonalModel(provider, model)) {
    throw new Error(`Model ${model} is not supported for ${provider}.`);
  }
}

export async function validatePersonalProviderKey(
  provider: PersonalInferenceProvider,
  apiKey: string
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${PROVIDER_BASE_URLS[provider]}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`The ${provider} API key could not be verified (HTTP ${response.status}).`);
    }
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const defaultModel = DEFAULT_PERSONAL_PROVIDER_MODELS[provider];
    if (!Array.isArray(payload.data) || !payload.data.some((model) => model.id === defaultModel)) {
      throw new Error(`The ${provider} API key does not have access to ${defaultModel}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`The ${provider} API key`)) throw error;
    if (controller.signal.aborted) {
      throw new Error(`The ${provider} API key verification timed out.`);
    }
    throw new Error(`The ${provider} API key could not be verified.`);
  } finally {
    clearTimeout(timeout);
  }
}
