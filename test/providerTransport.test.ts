import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../src/server/model/OpenRouterClient.js';
import {
  PERSONAL_PROVIDER_MODELS,
  validatePersonalProviderKey
} from '../src/server/model/providers.js';

afterEach(() => vi.unstubAllGlobals());

async function consume(client: OpenRouterClient, model: string, effortLevel: 'none' | 'low' | 'medium' | 'high' | 'max' = 'medium') {
  for await (const _chunk of client.streamChat({ model, messages: [], effortLevel })) { /* consume */ }
}

describe('provider transport', () => {
  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'fixture', 'reasoning'],
    ['openai', 'https://api.openai.com/v1/chat/completions', PERSONAL_PROVIDER_MODELS.openai[0].id, 'reasoning_effort'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions', PERSONAL_PROVIDER_MODELS.deepseek[0].id, 'reasoning_effort']
  ] as const)('routes %s only to its fixed host and request format', async (provider, url, model, reasoningField) => {
    const request = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    await consume(new OpenRouterClient({ apiKey: 'secret', provider }), model);
    const [actualUrl, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(actualUrl).toBe(url);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(body[reasoningField]).toBeDefined();
    expect(actualUrl).not.toContain(provider === 'openrouter' ? 'api.openai.com' : 'openrouter.ai');
  });

  it.each([
    ['none', undefined, { type: 'disabled' }],
    ['low', 'low', { type: 'enabled' }],
    ['medium', 'high', { type: 'enabled' }],
    ['max', 'max', { type: 'enabled' }]
  ] as const)('maps DeepSeek %s reasoning explicitly', async (effort, expected, thinking) => {
    const request = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    await consume(new OpenRouterClient({ apiKey: 'secret', provider: 'deepseek' }), 'deepseek-v4-flash', effort);
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBe(expected);
    expect(body.thinking).toEqual(thinking);
  });

  it('rejects unsupported direct-provider models before making a request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(consume(new OpenRouterClient({ apiKey: 'secret', provider: 'openai' }), 'google/gemini-2.5-flash'))
      .rejects.toThrow('not supported for openai');
    expect(request).not.toHaveBeenCalled();
  });

  it('validates personal keys against only the selected provider model endpoint', async () => {
    const request = vi.fn(async () => new Response('{"data":[{"id":"deepseek-v4-flash"}]}'));
    vi.stubGlobal('fetch', request);
    await validatePersonalProviderKey('deepseek', 'secret');
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('https://api.deepseek.com/v1/models');
  });

  it('sanitizes personal key validation failures and does not fall back', async () => {
    const request = vi.fn(async () => new Response('secret provider detail', { status: 401 }));
    vi.stubGlobal('fetch', request);
    await expect(validatePersonalProviderKey('openai', 'secret')).rejects.toThrow('HTTP 401');
    expect(request).toHaveBeenCalledTimes(1);
    await expect(validatePersonalProviderKey('openai', 'secret')).rejects.not.toThrow('secret provider detail');
  });

  it('rejects a successful model response that cannot access the provider default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[{"id":"unrelated"}]}')));
    await expect(validatePersonalProviderKey('deepseek', 'secret')).rejects.toThrow('does not have access');
  });

  it('returns DeepSeek reasoning with the assistant tool-call message on the next round', async () => {
    const first = 'data: {"choices":[{"delta":{"reasoning_content":"checked","tool_calls":[{"index":0,"id":"call"}]}}]}\n\ndata: [DONE]\n\n';
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(first))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    const client = new OpenRouterClient({ apiKey: 'secret', provider: 'deepseek' });
    await consume(client, 'deepseek-v4-flash');
    for await (const _chunk of client.streamChat({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function' }] },
        { role: 'tool', content: 'result', tool_call_id: 'call' }
      ],
      effortLevel: 'medium'
    })) { /* consume */ }
    const init = (request.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).messages[0].reasoning_content).toBe('checked');
  });

  it('retains DeepSeek reasoning for every prior assistant tool round', async () => {
    const round = (reasoning: string, id: string) => new Response(
      `data: {"choices":[{"delta":{"reasoning_content":"${reasoning}","tool_calls":[{"index":0,"id":"${id}"}]}}]}\n\ndata: [DONE]\n\n`
    );
    const request = vi.fn()
      .mockResolvedValueOnce(round('reason-a', 'call-a'))
      .mockResolvedValueOnce(round('reason-b', 'call-b'))
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    const client = new OpenRouterClient({ apiKey: 'secret', provider: 'deepseek' });
    await consume(client, 'deepseek-v4-flash');
    await consume(client, 'deepseek-v4-flash');
    for await (const _chunk of client.streamChat({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-a' }] },
        { role: 'tool', content: 'a', tool_call_id: 'call-a' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-b' }] },
        { role: 'tool', content: 'b', tool_call_id: 'call-b' }
      ]
    })) { /* consume */ }
    const init = (request.mock.calls[2] as unknown as [string, RequestInit])[1];
    const messages = JSON.parse(init.body as string).messages;
    expect(messages[0].reasoning_content).toBe('reason-a');
    expect(messages[2].reasoning_content).toBe('reason-b');
  });

  it('maps OpenAI max effort to its supported xhigh value', async () => {
    const request = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    await consume(new OpenRouterClient({ apiKey: 'secret', provider: 'openai' }), PERSONAL_PROVIDER_MODELS.openai[0].id, 'max');
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).reasoning_effort).toBe('xhigh');
  });

  it('does not report direct-provider costs when the API supplies token usage only', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const chunks = [];
    const client = new OpenRouterClient({ apiKey: 'secret', provider: 'openai' });
    for await (const chunk of client.streamChat({ model: PERSONAL_PROVIDER_MODELS.openai[0].id, messages: [] })) chunks.push(chunk);
    expect(chunks[0].usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5, costUsd: undefined });
  });
});
