import { describe, expect, it, vi } from 'vitest';
import { createReportTool } from '../src/server/agent/tools/CreateReportTool.js';
import type { QueryResultArtifact } from '../src/shared/types.js';
import type { ToolContext } from '../src/server/agent/types.js';

function artifact(rows: Record<string, unknown>[], options: { truncated?: boolean; rowCount?: number } = {}): QueryResultArtifact {
  return {
    kind: 'query-result', queryId: 'breakdown', query: 'SELECT customer, gross, net FROM breakdown',
    result: {
      columns: ['customer', 'gross', 'net'], rows, rowCount: options.rowCount ?? rows.length, elapsedMs: 1,
      ...(options.truncated ? { truncated: true, rowLimit: rows.length } : {})
    }
  };
}

function context(evidence: QueryResultArtifact): ToolContext {
  return {
    turnId: 'turn', connector: null, schema: null, emitEvent: vi.fn(),
    resolveArtifact: (id: string) => id === evidence.queryId ? evidence : undefined,
    controller: {
      getConnector: () => null, getSchema: () => null, refreshSchema: async () => null,
      getMemoryStore: vi.fn(), getConnectionId: () => 'fixture', audit: vi.fn()
    }
  } as unknown as ToolContext;
}

async function kpi(evidence: QueryResultArtifact, block: Record<string, unknown>) {
  return createReportTool().execute({ title: 'Revenue', blocks: [{ type: 'kpi', resultId: 'breakdown', ...block }] }, context(evidence));
}

describe('report KPI aggregation over owned evidence', () => {
  const breakdown = artifact([
    { customer: 'Ada', gross: 300, net: 280 },
    { customer: 'Cara', gross: 245, net: 240 },
    { customer: 'Ben', gross: 90, net: 90 }
  ]);

  it('sums the explicitly selected metric instead of selecting the first breakdown row', async () => {
    const net = await kpi(breakdown, { aggregation: 'sum', column: 'net', label: 'Net revenue' });
    const gross = await kpi(breakdown, { aggregation: 'sum', column: 'gross', label: 'Gross revenue' });
    expect((net.data?.blocks as Record<string, unknown>[]).find((block) => block.type === 'kpi')).toMatchObject({ value: 610, column: 'net', aggregation: 'sum', label: 'Net revenue' });
    expect((gross.data?.blocks as Record<string, unknown>[]).find((block) => block.type === 'kpi')).toMatchObject({ value: 635, column: 'gross', aggregation: 'sum', label: 'Gross revenue' });
  });

  it('keeps decimal-string precision, ignores NULL, and preserves unsafe-size totals as strings', async () => {
    const decimals = artifact([
      { customer: 'A', gross: 0, net: '9007199254740993.10' },
      { customer: 'B', gross: 0, net: null },
      { customer: 'C', gross: 0, net: '0.90' }
    ]);
    const result = await kpi(decimals, { aggregation: 'sum', column: 'net' });
    expect((result.data?.blocks as Record<string, unknown>[]).find((block) => block.type === 'kpi')).toMatchObject({ value: '9007199254740994.00' });
  });

  it.each([
    ['empty evidence', artifact([]), { aggregation: 'sum', column: 'net' }, /at least one/i],
    ['all NULL', artifact([{ customer: 'A', gross: 1, net: null }]), { aggregation: 'sum', column: 'net' }, /no non-NULL/i],
    ['truncated evidence', artifact([{ customer: 'A', gross: 1, net: 1 }], { truncated: true }), { aggregation: 'sum', column: 'net' }, /complete saved result/i],
    ['partial evidence', artifact([{ customer: 'A', gross: 1, net: 1 }], { rowCount: 2 }), { aggregation: 'sum', column: 'net' }, /complete saved result/i],
    ['unsafe numeric integer', artifact([{ customer: 'A', gross: 1, net: 9007199254740992 }]), { aggregation: 'sum', column: 'net' }, /unsafe numeric integers/i],
    ['missing explicit column', breakdown, { aggregation: 'sum' }, /explicit column/i],
    ['row and aggregation', breakdown, { aggregation: 'sum', column: 'net', rowIndex: 0 }, /cannot be combined/i],
    ['ambiguous first row', breakdown, { column: 'net' }, /rowIndex is required/i]
  ])('rejects %s', async (_name, evidence, block, message) => {
    const result = await kpi(evidence as QueryResultArtifact, block as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message as RegExp);
  });
});
