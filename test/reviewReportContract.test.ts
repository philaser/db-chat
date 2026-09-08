import { describe, expect, it, vi } from 'vitest';
import { createReportTool } from '../src/server/agent/tools/CreateReportTool.js';
import type { ToolContext } from '../src/server/agent/types.js';
import type { QueryResultArtifact } from '../src/shared/types.js';

function context(value: unknown): ToolContext {
  const artifact: QueryResultArtifact = {
    kind: 'query-result', queryId: 'scalar', query: 'SELECT value',
    result: { columns: ['value'], rows: [{ value }], rowCount: 1, elapsedMs: 1 }
  };
  return {
    turnId: 'review', connector: null, schema: null, emitEvent: vi.fn(),
    resolveArtifact: (id: string) => id === artifact.queryId ? artifact : undefined,
    controller: {
      getConnector: () => null, getSchema: () => null, refreshSchema: async () => null,
      getMemoryStore: vi.fn(), getConnectionId: () => 'fixture', audit: vi.fn()
    }
  } as unknown as ToolContext;
}

describe('reviewed final-report contract', () => {
  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1]
  ])('rejects a direct KPI containing %s', async (_name, value) => {
    const result = await createReportTool().execute({
      title: 'Scalar report',
      blocks: [{ type: 'kpi', resultId: 'scalar', column: 'value' }]
    }, context(value));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/finite|safe/i);
  });
});
