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
});
