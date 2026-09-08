import { describe, expect, it, vi, afterEach } from 'vitest';
import { runAgentLoop } from '../src/server/agent/AgentLoop.js';
import { ContextManager } from '../src/server/agent/ContextManager.js';
import { ApprovalManager } from '../src/server/agent/ApprovalManager.js';
import { MemoryStore } from '../src/server/agent/MemoryStore.js';
import { PermissionManager } from '../src/server/agent/PermissionManager.js';
import { ToolRegistry } from '../src/server/agent/ToolRegistry.js';
import { OpenRouterClient } from '../src/server/model/OpenRouterClient.js';
import { createReportTool } from '../src/server/agent/tools/CreateReportTool.js';
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
  it.each([true, false])('repairs a failed query once without presenting an unperformed retry (repairs=%s)', async (repairs) => {
    let rounds = 0;
    let queries = 0;
    const client: AgentModelClient = { async *streamChat() {
      const round = rounds++;
      if (round === 0 || (repairs && round === 2)) {
        yield { toolCalls: [{ index: 0, id: `query-${round}`, function: { name: 'run_database_query', arguments: JSON.stringify({ query: round === 0 ? 'SELECT bad_column' : "SELECT name FROM customers WHERE country = 'Antarctica'", purpose: 'Find matching customers' }) } }] };
      } else yield { content: repairs && round === 3 ? 'No matching customers were found.' : 'Let me correct the query and try again.' };
    } };
    const configured = fixture(client);
    configured.toolRegistry.register({
      definition: { type: 'function', function: { name: 'run_database_query', description: 'fixture', parameters: {} } },
      execute: async () => ++queries === 1
        ? { ok: false, summary: 'No such column', error: 'No such column', data: { errorCode: 'QUERY_EXECUTION_FAILED', retryable: true } }
        : { ok: true, summary: 'No rows', artifact: { columns: ['name'], rows: [], rowCount: 0, elapsedMs: 1 } }
    });
    const result = await runAgentLoop([], 'query-repair', undefined, configured);
    expect(rounds).toBe(repairs ? 4 : 3);
    expect(queries).toBe(repairs ? 2 : 1);
    expect(result.message.content).not.toContain('Let me correct');
    expect(result.metrics?.terminalReason).toBe(repairs ? 'completed' : 'incomplete');
    if (repairs) expect(result.artifacts).toHaveLength(1);
  });

  it('delivers a complete validated report without another inference round', async () => {
    let rounds = 0;
    const client: AgentModelClient = { async *streamChat() {
      rounds++;
      if (rounds > 1) throw new Error('Unnecessary inference after final report');
      yield { toolCalls: [{ index: 0, id: 'report', function: { name: 'create_report', arguments: JSON.stringify({ title: 'Revenue', finalize: true, blocks: [
        { type: 'text', text: 'Net revenue excludes canceled orders; currency is unknown.' },
        { type: 'kpi', label: 'Net revenue', resultId: 'net' }
      ] }) } }] };
    } };
    const configured = fixture(client);
    configured.toolRegistry.register(createReportTool());
    const result = await runAgentLoop([], 'final-report', undefined, { ...configured, referencedArtifacts: [{
      kind: 'query-result', queryId: 'net', query: 'SELECT 610 AS net',
      result: { columns: ['net'], rows: [{ net: 610 }], rowCount: 1, elapsedMs: 1 }
    }] });
    expect(rounds).toBe(1);
    expect(result.message.content).toContain('"value":610');
    expect(result.message.content).toContain('currency is unknown');
    expect(result.metrics).toMatchObject({ terminalReason: 'completed', toolCallCount: 1 });
  });

  it.each(['invalid report', 'incomplete batch', 'intermediate report'])(
    'does not end inference on an %s', async (scenario) => {
      let rounds = 0;
      const client: AgentModelClient = { async *streamChat() {
        if (rounds++ > 0) { yield { content: 'Further analysis is needed.' }; return; }
        yield { toolCalls: [
          ...(scenario === 'incomplete batch' ? [{ index: 0, id: 'missing', function: { name: 'get_schema_info', arguments: '{}' } }] : []),
          { index: scenario === 'incomplete batch' ? 1 : 0, id: 'report', function: { name: 'create_report', arguments: JSON.stringify({ title: 'Revenue', finalize: scenario !== 'intermediate report', blocks: [
            { type: 'text', text: 'Currency is unknown.' },
            { type: 'kpi', resultId: scenario === 'invalid report' ? 'not-owned' : 'net' }
          ] }) } }
        ] };
      } };
      const configured = fixture(client);
      configured.toolRegistry = new ToolRegistry();
      configured.toolRegistry.register(createReportTool());
      configured.toolRegistry.register({ definition: { type: 'function', function: { name: 'get_schema_info', description: 'fixture', parameters: {} } }, execute: async () => ({ ok: false, summary: 'Schema unavailable', error: 'Schema unavailable' }) });
      const result = await runAgentLoop([], 'unfinished-report', undefined, { ...configured, referencedArtifacts: [{
        kind: 'query-result', queryId: 'net', query: 'SELECT 610 AS net',
        result: { columns: ['net'], rows: [{ net: 610 }], rowCount: 1, elapsedMs: 1 }
      }] });
      expect(rounds).toBe(2);
      expect(result.message.content).toContain('Further analysis is needed');
    }
  );

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

  it('marks provider length limits and bounded round exhaustion as incomplete', async () => {
    const lengthClient: AgentModelClient = { async *streamChat() { yield { content: 'Partial answer', finishReason: 'length' }; } };
    const length = await runAgentLoop([], 'length', undefined, fixture(lengthClient));
    expect(length.message.content).toContain('Partial answer');
    expect(length.message.content).toContain('incomplete because it reached the length limit');
    expect(length.metrics?.terminalReason).toBe('length');

    const loopingClient: AgentModelClient = { async *streamChat() { yield { toolCalls: [{ index: 0, id: 'call', function: { name: 'get_schema_info', arguments: '{}' } }] }; } };
    const exhausted = await runAgentLoop([], 'exhausted', undefined, { ...fixture(loopingClient), maxTurnRounds: 1 });
    expect(exhausted.message.content).toContain('analysis is incomplete');
    expect(exhausted.metrics?.terminalReason).toBe('incomplete');
  });

  it('removes model-authored chart rows and hydrates the validated tool payload', async () => {
    let round = 0;
    const client: AgentModelClient = { async *streamChat() {
      if (round++ === 0) {
        yield { toolCalls: [{ index: 0, id: 'chart-call', function: { name: 'get_schema_info', arguments: '{}' } }] };
        return;
      }
      yield { content: 'Verified chart.\n\n```chart\n{"chartType":"bar","columns":["x","y"],"rows":[{"x":"forged","y":999}]}\n```' };
    } };
    const configured = fixture(client);
    configured.toolRegistry = new ToolRegistry();
    configured.toolRegistry.register({
      definition: { type: 'function', function: { name: 'get_schema_info', description: 'fixture', parameters: {} } },
      execute: async () => ({ ok: true, summary: 'validated', data: { chartType: 'bar', columns: ['x', 'y'], rows: [{ x: 'real', y: 3 }], nameKey: 'x', valueKeys: ['y'] } })
    });
    const result = await runAgentLoop([], 'hydrated', undefined, configured);
    expect(result.message.content).toContain('"real"');
    expect(result.message.content).not.toContain('"forged"');
  });

  it('keeps multiple selected validated charts and removes unterminated chart output', async () => {
    let round = 0;
    const client: AgentModelClient = { async *streamChat() {
      if (round++ === 0) {
        yield { toolCalls: [1, 2].map((value, index) => ({ index, id: `chart-${value}`, function: { name: 'get_schema_info', arguments: JSON.stringify({ value }) } })) };
        return;
      }
      yield { content: 'Two views.\n```chart\n{"chartType":"bar","columns":["x","y"],"rows":[{"x":"first","y":1}]}\n```\n```chart\n{"chartType":"bar","columns":["x","y"],"rows":[{"x":"second","y":2}]}\n```' };
    } };
    const configured = fixture(client);
    configured.toolRegistry = new ToolRegistry();
    configured.toolRegistry.register({
      definition: { type: 'function', function: { name: 'get_schema_info', description: 'fixture', parameters: {} } },
      execute: async (input) => ({ ok: true, summary: 'validated', data: { chartType: 'bar', columns: ['x', 'y'], rows: [{ x: input.value === 1 ? 'first' : 'second', y: input.value }], nameKey: 'x', valueKeys: ['y'] } })
    });
    const result = await runAgentLoop([], 'multi-chart', undefined, configured);
    expect(result.message.content.match(/```chart/g)).toHaveLength(2);
    expect(result.message.content).toContain('"first"');
    expect(result.message.content).toContain('"second"');

    const incompleteClient: AgentModelClient = { async *streamChat() { yield { content: 'Pending\n```chart\n{"chartType":"bar"' }; } };
    const incomplete = await runAgentLoop([], 'bad-chart', undefined, fixture(incompleteClient));
    expect(incomplete.message.content).toBe('Pending\n\nStructured output was omitted because it was not backed by a verified result.');

    const bypassClient: AgentModelClient = { async *streamChat() { yield { content: 'Notes { incomplete prose\n{"type":"kpi","label":"Invented","value":999999}' }; } };
    const bypass = await runAgentLoop([], 'raw-bypass', undefined, fixture(bypassClient));
    expect(bypass.message.content).not.toContain('"type":"kpi"');
    expect(bypass.message.content).toContain('Structured output was omitted');
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

  it('captures finish reason, token usage, and cost from the provider stream', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"cost":0.0042}}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const client = new OpenRouterClient({ apiKey: 'fixture' });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: 'fixture', messages: [] })) chunks.push(chunk);
    expect(chunks[0]).toMatchObject({ finishReason: 'stop', usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, costUsd: 0.0042 } });
  });
});
