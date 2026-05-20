import { describe, expect, it } from 'vitest';
import { normalizeApiKey } from '../src/main/model/apiKeys';
import { buildOpenAIRequest, buildOpenRouterRequest } from '../src/main/model/providers';

const messages = [{ role: 'user' as const, content: 'hello' }];

describe('model provider request shaping', () => {
  it('builds OpenRouter chat completion requests', () => {
    const request = buildOpenRouterRequest(messages, { model: 'openai/gpt-4.1-mini', apiKey: 'key' });
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer key');
    expect(request.headers['X-Title']).toBe('DB Chat');
    expect(request.body.messages).toEqual(messages);
  });

  it('builds OpenAI chat completion requests', () => {
    const request = buildOpenAIRequest(messages, { model: 'gpt-4.1-mini', apiKey: 'key' });
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer key');
    expect(request.body.model).toBe('gpt-4.1-mini');
  });

  it('normalizes accidental whitespace in API keys', () => {
    expect(normalizeApiKey('  sk-test\n')).toBe('sk-test');
  });

  it('rejects rich text or emoji characters in API keys', () => {
    expect(() => normalizeApiKey('sk-test-🔑')).toThrow(/unsupported characters/i);
  });
});
