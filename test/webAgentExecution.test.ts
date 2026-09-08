import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAgentService } from '../src/server/webAgentService.js';
import { loadWebServerConfig } from '../src/server/config.js';
import * as factory from '../src/server/connectorFactory.js';
import type { DatabaseConnector, DatabaseSchema, ConnectionConfig } from '../src/shared/types.js';

const database: ConnectionConfig = { id: 'fixture', kind: 'sqlite', label: 'Fixture', databasePath: '/unused', createdAt: '2026-09-05' };
const schema: DatabaseSchema = { kind: 'sqlite', label: 'Fixture', tables: [] };
function connector(): DatabaseConnector {
  return { connect: vi.fn(async () => undefined), introspect: vi.fn(async () => schema), executeQuery: vi.fn(), getContextForPrompt: vi.fn(async () => 'Fixture'), setSafetyLevel: vi.fn(), close: vi.fn() };
}
afterEach(() => vi.restoreAllMocks());

describe('web agent execution', () => {
  it('uses the selected account model for inference', async () => {
    const requestedModels: string[] = [];
    const requestedEfforts: Array<string | undefined> = [];
    const service = new WebAgentService({ ...loadWebServerConfig({}), database }, {
      connector: connector(),
      modelClient: { async *streamChat(options) { requestedModels.push(options.model); requestedEfforts.push(options.effortLevel); yield { content: 'answer' }; } }
    });
    await service.initialize();
    await service.run([{ role: 'user', content: 'question' }], 'turn', () => undefined, undefined, database, undefined, 'selected/model', 'high');
    expect(requestedModels).toEqual(['selected/model']);
    expect(requestedEfforts).toEqual(['high']);
    service.close();
  });

  it.each(['connect', 'introspect'] as const)('closes a scoped connection when %s fails', async method => {
    const raw = connector();
    vi.mocked(raw[method]).mockRejectedValueOnce(new Error('fixture failure'));
    vi.spyOn(factory, 'createConfiguredConnector').mockReturnValue(raw);
    const service = new WebAgentService(loadWebServerConfig({}));
    await expect(service.run([], 'turn', () => undefined, undefined, database)).rejects.toThrow('fixture failure');
    expect(raw.close).toHaveBeenCalledOnce();
  });

  it('hydrates an automatic chart from all 15 current result rows without a second introspection', async () => {
    const fixtureSchema: DatabaseSchema = { kind: 'sqlite', label: 'Fixture', tables: [{ name: 'metrics', columns: [
      { name: 'category', type: 'text', nullable: false, primaryKey: false },
      { name: 'amount', type: 'integer', nullable: false, primaryKey: false }
    ] }] };
    const rows = Array.from({ length: 15 }, (_, index) => ({ category: `C${index + 1}`, amount: index + 1 }));
    const raw: DatabaseConnector = {
      connect: vi.fn(async () => undefined), introspect: vi.fn(async () => fixtureSchema),
      executeQuery: vi.fn(async () => ({ columns: ['category', 'amount'], rows, rowCount: rows.length, elapsedMs: 1 })),
      getContextForPrompt: vi.fn(async () => { throw new Error('schema prompt should reuse introspection'); }), setSafetyLevel: vi.fn(), close: vi.fn()
    };
    let round = 0;
    const service = new WebAgentService({ ...loadWebServerConfig({}), database }, {
      connector: raw,
      modelClient: { async *streamChat() {
        if (round++ === 0) {
          yield { toolCalls: [{ index: 0, id: 'query', function: { name: 'run_database_query', arguments: JSON.stringify({ query: 'SELECT category, amount FROM metrics', purpose: 'Compare metrics' }) } }] };
          return;
        }
        yield { content: 'The comparison is ready.' };
      } }
    });
    await service.initialize();
    const result = await service.run([{ role: 'user', content: 'Show a bar chart of the metrics.' }], 'chart-turn', () => undefined, undefined, database);
    const match = /```chart\n([\s\S]+)\n```/.exec(result.message.content);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toMatchObject({ resultId: 'chart-turn-query-1', chartType: 'bar', coverage: { returnedRowCount: 15, totalRowCount: 15 } });
    expect(JSON.parse(match![1]).rows).toHaveLength(15);
    expect(raw.introspect).toHaveBeenCalledOnce();
    expect(raw.getContextForPrompt).not.toHaveBeenCalled();
    service.close();
  });
});
