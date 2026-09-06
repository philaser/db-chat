import { describe, expect, it, vi, afterEach } from 'vitest';
import { runAgentLoop } from '../src/server/agent/AgentLoop.js';
import { ContextManager } from '../src/server/agent/ContextManager.js';
import { ApprovalManager } from '../src/server/agent/ApprovalManager.js';
import { MemoryStore } from '../src/server/agent/MemoryStore.js';
import { PermissionManager } from '../src/server/agent/PermissionManager.js';
import { ToolRegistry } from '../src/server/agent/ToolRegistry.js';
import { OpenRouterClient } from '../src/server/model/OpenRouterClient.js';
import type { AgentController, AgentModelClient } from '../src/server/agent/types.js';
import type { AgentEvent, ModelChatMessage } from '../src/shared/types.js';

function fixture(client: AgentModelClient) {
  const memoryStore = new MemoryStore();
  const controller: AgentController = {
    getConnector: () => null, getSchema: () => null, refreshSchema: async () => null,
    getMemoryStore: () => memoryStore, getConnectionId: () => 'fixture', audit: vi.fn()
  };
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({ definition: { type: 'function', function: { name: 'get_schema_info', description: 'fixture', parameters: {} } }, execute: async () => ({ ok: true, summary: 'done' }) });
  const permissionManager = new PermissionManager();
  permissionManager.setSafetyLevel('unrestricted');
  return { client, model: 'fixture', memoryStore, controller, toolRegistry, permissionManager, approvalManager: new ApprovalManager() };
}

afterEach(() => vi.unstubAllGlobals());

describe('agent execution invariants', () => {
  it('rejects a partial provider failure instead of returning success', async () => {
    const events: AgentEvent[] = [];
    const client: AgentModelClient = { async *streamChat() { yield { content: 'partial' }; throw new Error('provider failed'); } };
    await expect(runAgentLoop([], 'failure', event => events.push(event), fixture(client))).rejects.toThrow('provider failed');
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.some(event => event.type === 'complete')).toBe(false);
  });

  it('pairs every requested tool call even when execution limits truncate a batch', async () => {
    let round = 0;
    const client: AgentModelClient = { async *streamChat(options) {
      if (round++ === 0) { yield { toolCalls: [0, 1, 2].map(index => ({ index, id: `call-${index}`, function: { name: 'get_schema_info', arguments: '{}' } })) }; return; }
      const request = options.messages.find(message => message.tool_calls);
      expect(request?.tool_calls).toHaveLength(3);
      expect(options.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id).sort()).toEqual(['call-0', 'call-1', 'call-2']);
      yield { content: 'done' };
    } };
    await runAgentLoop([], 'limited', undefined, { ...fixture(client), maxParallelTools: 1 });
    expect(round).toBe(2);
  });

  it('cancels and removes a pending approval', async () => {
    const approvals = new ApprovalManager();
    const interruption = approvals.createInterruption('turn', 'query', {});
    const controller = new AbortController();
    const waiting = approvals.waitForDecision(interruption.id, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(approvals.getPending(interruption.id)).toBeUndefined();
  });

  it('preserves system instructions and complete tool exchanges while compacting', async () => {
    const client: AgentModelClient = { async *streamChat(options) {
      expect(options.messages.every(message => !message.tool_calls)).toBe(true);
      yield { content: 'Earlier conversation summary' };
    } };
    const manager = new ContextManager(client, 'fixture', { highWaterMark: 0.1, criticalMark: 0.9, maxMessages: 50, keepRecent: 2 });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'Permanent schema and safety instructions' },
      { role: 'user', content: 'old'.repeat(100) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'query', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call', content: 'result' },
      { role: 'assistant', content: 'answer' }
    ];
    const compacted = await manager.compact(messages, [], 'schema', 100);
    expect(compacted.messages[0]).toEqual(messages[0]);
    expect(compacted.messages.slice(-3)).toEqual(messages.slice(-3));
  });

  it.each(['none', 'low', 'medium', 'high', 'max'] as const)('sends %s reasoning effort without remapping', async effortLevel => {
    const request = vi.fn(async () => new Response('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', request);
    const client = new OpenRouterClient({ apiKey: 'fixture' });
    for await (const _chunk of client.streamChat({ model: 'fixture', messages: [], effortLevel })) { /* consume */ }
    const requestOptions = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(requestOptions[1].body as string).reasoning).toEqual({ effort: effortLevel });
  });

  it.each(['data: {"error":{"message":"failed"}}\n\n', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])('rejects error or truncated SSE responses', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const client = new OpenRouterClient({ apiKey: 'fixture' });
    await expect((async () => { for await (const _chunk of client.streamChat({ model: 'fixture', messages: [] })) { /* consume */ } })()).rejects.toThrow();
  });
});
