import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcController } from '../src/main/ipc';
import { openRouterProvider } from '../src/main/model/providers';
import { AppStore } from '../src/main/storage/AppStore';
import type { DatabaseConnector, DatabaseSchema, ModelProviderResponse, QueryExecutionMode } from '../src/shared/types';

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => []
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  app: {
    getPath: () => tmpdir()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}));

function createController(connector: DatabaseConnector): IpcController {
  const dir = mkdtempSync(path.join(tmpdir(), 'db-chat-ipc-'));
  const store = new AppStore(path.join(dir, 'store.json'));
  store.saveSettings({
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    safeMode: true
  });
  store.saveApiKey('openrouter', 'test-key');
  const controller = new IpcController(store);
  (controller as unknown as { connector: DatabaseConnector }).connector = connector;
  (controller as unknown as { schema: DatabaseSchema }).schema = {
    kind: 'sqlite',
    label: 'test',
    tables: [{ name: 'users', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }] }]
  };
  return controller;
}

function createConnector(blockPattern?: RegExp): DatabaseConnector {
  return {
    connect: vi.fn(),
    introspect: vi.fn(),
    validateQuery: vi.fn((query: string, _mode: QueryExecutionMode) => {
      const blocked = blockPattern?.test(query) ?? false;
      return {
        safe: !blocked,
        reason: blocked ? 'Blocked by SAFE mode.' : 'Read-only query allowed by SAFE mode.',
        normalizedQuery: query
      };
    }),
    executeQuery: vi.fn(async (query: string) => ({
      columns: ['query'],
      rows: [{ query }],
      rowCount: 1,
      elapsedMs: 2
    })),
    getContextForPrompt: vi.fn(async () => 'Table users: id integer'),
    close: vi.fn()
  };
}

describe('IpcController tool query loop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('executes dependent model tool calls across rounds', async () => {
    const connector = createConnector();
    const controller = createController(connector);
    vi.spyOn(openRouterProvider, 'sendChatWithTools')
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'run_database_query',
            arguments: JSON.stringify({ query: 'select id from users;', purpose: 'Find users' })
          }
        }]
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'call-2',
          type: 'function',
          function: {
            name: 'run_database_query',
            arguments: JSON.stringify({ query: 'select count(*) as attempts from attempts where user_id = 1;', purpose: 'Count attempts' })
          }
        }]
      })
      .mockResolvedValueOnce({ content: 'Two checks are complete.' });

    const response = await controller.sendChat([{ role: 'user', content: 'check users and attempts' }]);

    expect(response.message.content).toBe('Two checks are complete.');
    expect(response.generatedQueries).toHaveLength(2);
    expect(response.queryResults).toHaveLength(2);
    expect(connector.executeQuery).toHaveBeenCalledTimes(2);
  });

  it('returns blocked tool results to the model without executing unsafe queries', async () => {
    const connector = createConnector(/drop/i);
    const controller = createController(connector);
    const providerSpy = vi.spyOn(openRouterProvider, 'sendChatWithTools')
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'call-drop',
          type: 'function',
          function: {
            name: 'run_database_query',
            arguments: JSON.stringify({ query: 'drop table users;', purpose: 'Unsafe check' })
          }
        }]
      })
      .mockResolvedValueOnce({ content: 'That query was blocked safely.' });

    const response = await controller.sendChat([{ role: 'user', content: 'drop users' }]);
    const secondRoundMessages = providerSpy.mock.calls[1][0];

    expect(response.message.content).toBe('That query was blocked safely.');
    expect(connector.executeQuery).not.toHaveBeenCalled();
    expect(response.generatedQueries?.[0].validation.safe).toBe(false);
    expect(secondRoundMessages.at(-1)?.content).toContain('Blocked by SAFE mode.');
  });

  it('falls back to fenced query extraction when the model returns no tool calls and no direct answer', async () => {
    const connector = createConnector();
    const controller = createController(connector);
    vi.spyOn(openRouterProvider, 'sendChatWithTools').mockResolvedValueOnce({ content: '```sql\nselect id from users;\n```' });
    vi.spyOn(openRouterProvider, 'sendChat').mockResolvedValueOnce('Here is the result.');

    const response = await controller.sendChat([{ role: 'user', content: 'show users' }]);

    expect(response.message.content).toBe('Here is the result.');
    expect(response.generatedQuery?.query).toBe('select id from users;');
    expect(response.activity?.some((step) => step.status === 'success' && step.query === 'select id from users;')).toBe(true);
    expect(connector.executeQuery).toHaveBeenCalledOnce();
  });

  it('returns activity when tool calling is unavailable and the legacy query path runs', async () => {
    const connector = createConnector();
    const controller = createController(connector);
    vi.spyOn(openRouterProvider, 'sendChatWithTools').mockRejectedValueOnce(new Error('tools are not supported'));
    vi.spyOn(openRouterProvider, 'sendChat')
      .mockResolvedValueOnce('```sql\nselect id from users;\n```')
      .mockResolvedValueOnce('Here is the fallback result.');

    const response = await controller.sendChat([{ role: 'user', content: 'show users' }]);

    expect(response.message.content).toBe('Here is the fallback result.');
    expect(response.generatedQuery?.query).toBe('select id from users;');
    expect(response.activity?.some((step) => step.status === 'success' && step.query === 'select id from users;')).toBe(true);
    expect(connector.executeQuery).toHaveBeenCalledOnce();
  });

  it('streams query activity events through the provided turn channel', async () => {
    const connector = createConnector();
    const controller = createController(connector);
    const webContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn()
    };
    vi.spyOn(openRouterProvider, 'sendChatWithTools')
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'run_database_query',
            arguments: JSON.stringify({ query: 'select id from users;', purpose: 'Find users' })
          }
        }]
      })
      .mockResolvedValueOnce({ content: 'Done.' });

    await controller.sendChat(
      [{ role: 'user', content: 'show users' }],
      'turn-stream-test',
      webContents as unknown as Parameters<IpcController['sendChat']>[2]
    );

    expect(webContents.send).toHaveBeenCalledWith(
      'dbchat:chat-progress:turn-stream-test',
      expect.objectContaining({
        turnId: 'turn-stream-test',
        step: expect.objectContaining({
          status: 'running',
          query: 'select id from users;'
        })
      })
    );
    expect(webContents.send).toHaveBeenCalledWith(
      'dbchat:chat-progress:turn-stream-test',
      expect.objectContaining({
        step: expect.objectContaining({
          status: 'success',
          query: 'select id from users;'
        })
      })
    );
  });

  it('surfaces the query limit as a tool result', async () => {
    const connector = createConnector();
    const controller = createController(connector);
    const toolRound: ModelProviderResponse = {
      content: '',
      toolCalls: Array.from({ length: 3 }, (_, index) => ({
        id: `call-${index}`,
        type: 'function' as const,
        function: {
          name: 'run_database_query',
          arguments: JSON.stringify({ query: `select ${index};`, purpose: `Check ${index}` })
        }
      }))
    };
    const providerSpy = vi.spyOn(openRouterProvider, 'sendChatWithTools')
      .mockResolvedValueOnce(toolRound)
      .mockResolvedValueOnce(toolRound)
      .mockResolvedValueOnce(toolRound)
      .mockResolvedValueOnce({ content: 'Stopped safely.' });

    const response = await controller.sendChat([{ role: 'user', content: 'many checks' }]);
    const limitedRoundMessages = providerSpy.mock.calls[3][0];

    expect(response.message.content).toBe('Stopped safely.');
    expect(connector.executeQuery).toHaveBeenCalledTimes(8);
    expect(limitedRoundMessages.some((message) => message.role === 'tool' && message.content.includes('after 8 queries'))).toBe(true);
  });
});
