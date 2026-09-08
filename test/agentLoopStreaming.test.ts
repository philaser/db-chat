import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, DatabaseConnector, DatabaseSchema } from '../src/shared/types.js';
import { runAgentLoop } from '../src/server/agent/AgentLoop.js';
import { ApprovalManager } from '../src/server/agent/ApprovalManager.js';
import { MemoryStore } from '../src/server/agent/MemoryStore.js';
import { PermissionManager } from '../src/server/agent/PermissionManager.js';
import { ToolRegistry } from '../src/server/agent/ToolRegistry.js';
import type { AgentController, AgentModelClient } from '../src/server/agent/types.js';

describe('agent loop streaming', () => {
  it('emits only final prose after tool activity', async () => {
    const schema: DatabaseSchema = { kind: 'sqlite', label: 'Fixture', tables: [] };
    const connector: DatabaseConnector = {
      connect: vi.fn(),
      introspect: vi.fn(async () => schema),
      executeQuery: vi.fn(),
      getContextForPrompt: vi.fn(async () => 'Fixture schema'),
      setSafetyLevel: vi.fn(),
      close: vi.fn()
    };
    const memoryStore = new MemoryStore();
    const controller: AgentController = {
      getConnector: () => connector,
      getSchema: () => schema,
      refreshSchema: async () => schema,
      getMemoryStore: () => memoryStore,
      getConnectionId: () => 'fixture',
      audit: vi.fn()
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'run_database_query',
          description: 'Run a fixture query',
          parameters: { type: 'object', properties: {} }
        }
      },
      execute: async () => ({ ok: true, summary: 'Query complete' })
    });
    let modelRound = 0;
    const client: AgentModelClient = {
      async *streamChat() {
        modelRound += 1;
        if (modelRound === 1) {
          yield { content: 'I will check the data.' };
          yield {
            toolCalls: [{
              index: 0,
              id: 'call-1',
              type: 'function',
              function: {
                name: 'run_database_query',
                arguments: JSON.stringify({ query: 'SELECT 1', purpose: 'Check the data' })
              }
            }]
          };
          return;
        }
        yield { content: 'The result is clear.' };
      }
    };
    const events: AgentEvent[] = [];

    const result = await runAgentLoop(
      [{ role: 'user', content: 'Check the data.' }],
      'turn-1',
      (event) => events.push(event),
      {
        model: 'fixture-model',
        client,
        controller,
        memoryStore,
        toolRegistry,
        permissionManager: new PermissionManager(),
        approvalManager: new ApprovalManager()
      }
    );

    expect(events.filter((event) => event.type === 'text-delta').map((event) => event.data.delta).join('')).toBe('The result is clear.');
    expect(result.message.content).toBe('The result is clear.');
  });
});
