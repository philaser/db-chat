import { describe, expect, it } from 'vitest';
import type { ModelChatMessage, QueryResultArtifact } from '../src/shared/types.js';
import { visualizeDataTool } from '../src/server/agent/tools/VisualizeDataTool.js';
import {
  buildVisualizationInput,
  hasChartMarkup,
  hasVisualizationRequest,
  inferChartType,
  selectVisualizationArtifact
} from '../src/server/visualizationEnrichment.js';

const messages: ModelChatMessage[] = [{
  role: 'user',
  content: 'Show me a line chart of invoice count by month.'
}];

const artifact: QueryResultArtifact = {
  kind: 'query-result',
  queryId: 'turn-query-1',
  query: 'SELECT month, invoice_count FROM invoices_by_month',
  result: {
    columns: ['month', 'invoice_count'],
    rows: [
      { month: '2026-01', invoice_count: 7 },
      { month: '2026-02', invoice_count: 8 },
      { month: '2026-03', invoice_count: 9 },
      { month: '2026-04', invoice_count: 11 }
    ],
    rowCount: 4,
    elapsedMs: 2
  }
};

describe('visualization enrichment', () => {
  it('selects a useful query result and infers the requested chart type', () => {
    expect(hasVisualizationRequest(messages)).toBe(true);
    const selected = selectVisualizationArtifact([artifact]);
    expect(selected).toMatchObject({ nameKey: 'month', valueKeys: ['invoice_count'] });
    expect(inferChartType(messages, selected!.nameKey, artifact.result.rows)).toBe('line');
    expect(buildVisualizationInput(messages, selected!)).toMatchObject({
      chartType: 'line',
      nameKey: 'month',
      valueKeys: ['invoice_count'],
      rows: artifact.result.rows
    });
  });

  it('recognizes charts already included in an assistant response', () => {
    expect(hasChartMarkup('```chart\n{"chartType":"bar"}\n```')).toBe(true);
    expect(hasChartMarkup('{"chartType":"line","columns":[]}')).toBe(true);
    expect(hasChartMarkup('```blocks\n[{"type":"table","columns":["A"],"rows":[]}]\n```')).toBe(false);
    expect(hasChartMarkup('A regular answer with a table.')).toBe(false);
  });

  it('infers slope charts for explicit two-period comparisons', () => {
    const slopeMessages: ModelChatMessage[] = [{ role: 'user', content: 'Compare Q1 and Q2 growth by channel as a slope chart.' }];
    const slopeArtifact: QueryResultArtifact = {
      ...artifact,
      result: {
        ...artifact.result,
        columns: ['channel', 'q1_growth', 'q2_growth'],
        rows: [
          { channel: 'Organic search', q1_growth: 18, q2_growth: 28 },
          { channel: 'Partner', q1_growth: 22, q2_growth: 17 }
        ]
      }
    };
    const selected = selectVisualizationArtifact([slopeArtifact]);
    expect(selected).not.toBeNull();
    expect(inferChartType(slopeMessages, selected!.nameKey, slopeArtifact.result.rows)).toBe('slope');
    expect(buildVisualizationInput(slopeMessages, selected!)).toMatchObject({ chartType: 'slope', valueKeys: ['q1_growth', 'q2_growth'] });
  });

  it('validates every supported chart type through the shared tool contract', async () => {
    const chartTypes = ['bar', 'line', 'area', 'pie', 'scatter', 'radar', 'radialBar', 'composed', 'funnel', 'treemap', 'sunburst', 'slope'] as const;
    for (const chartType of chartTypes) {
      const result = await visualizeDataTool.execute({
        chartType,
        columns: ['category', 'first', 'second'],
        rows: [
          { category: 'A', first: 1, second: 2 },
          { category: 'B', first: 3, second: 4 }
        ],
        nameKey: 'category',
        valueKeys: chartType === 'scatter' || chartType === 'slope' ? ['first', 'second'] : chartType === 'pie' || chartType === 'radialBar' || chartType === 'funnel' ? ['first'] : ['first', 'second']
      }, {} as never);
      expect(result.ok, `${chartType} should validate`).toBe(true);
    }
  });
});
