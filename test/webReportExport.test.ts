import { describe, expect, it } from 'vitest';
import { buildAnswerReport, collectReportCharts } from '../src/web/reportExport.js';
import type { QueryResultArtifact, ChatMessage } from '../src/shared/types.js';
const artifact: QueryResultArtifact = { kind: 'query-result', queryId: 'result-1', query: 'select amount from orders', result: { columns: ['name', 'amount'], rows: [{ name: '<script>alert(1)</script>', amount: 30 }, { name: 'Ada|Ben', amount: null }], rowCount: 2, elapsedMs: 2, truncated: true }, source: { connectionId: 'source', label: 'Demo', kind: 'sqlite', capturedAt: '2026-09-08T00:00:00Z' } };
const messages: ChatMessage[] = [{ id: 'answer', role: 'assistant', content: '**Total:** 30\n\n<script>alert(2)</script>\n\n[unsafe](javascript:alert(3))', createdAt: '2026-09-08' }];
describe('portable analysis reports', () => {
  it('exports a rich answer and bounded original evidence without executable content', () => {
    const html = buildAnswerReport({ title: '<script>title</script>', messages, artifacts: [artifact, artifact], format: 'html' });
    const dom = new DOMParser().parseFromString(html, 'text/html');
    expect(dom.querySelector('script')).toBeNull();
    expect(dom.querySelector('a')?.getAttribute('href')).not.toMatch(/^javascript:/);
    expect(dom.querySelector('strong')?.textContent).toBe('Total:');
    expect(dom.querySelectorAll('.evidence')).toHaveLength(1);
    expect(dom.body.textContent).toContain('Limited preview');
    expect(dom.body.textContent).toContain('Demo · sqlite');
    expect(dom.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
  });
  it('keeps Markdown rows contiguous, escapes delimiters and retains null/limit meaning', () => {
    const md = buildAnswerReport({ title: 'Analysis', messages: [], artifacts: [artifact], format: 'markdown', generatedAt: 'fixed' });
    expect(md).toContain('| name | amount |\n| --- | --- |\n');
    expect(md).toContain('Ada\\|Ben | —');
    expect(md).toContain('limited preview, not the complete dataset');
    expect(md).toContain('select amount from orders');
  });
  it('preserves validated report KPIs and units in both export formats', () => {
    const report: ChatMessage = { ...messages[0], content: '```blocks\n' + JSON.stringify([{ type: 'heading', text: 'Sales' }, { type: 'kpi', resultId: 'result-1', label: 'Net revenue', value: 30, unit: 'USD' }]) + '\n```' };
    const md = buildAnswerReport({ title: 'Sales', messages: [report], artifacts: [artifact], format: 'markdown' });
    expect(md).toContain('**Net revenue: 30 USD**');
    const html = buildAnswerReport({ title: 'Sales', messages: [report], artifacts: [artifact], format: 'html' });
    expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toContain('Net revenue: 30 USD');
    expect(html).not.toContain('```blocks');
  });
  it('captures only local chart graphics with handlers and active nodes removed', () => {
    const container = document.createElement('div');
    container.innerHTML = '<figure aria-label="Chart: Revenue"><svg class="recharts-surface" onload="alert(1)"><rect width="20" height="10"/><script>alert(2)</script><a href="https://example.com"><text>x</text></a><image href="https://example.com/a"/></svg></figure>';
    document.body.append(container);
    const charts = collectReportCharts(container);
    expect(charts).toHaveLength(1);
    const svg = decodeURIComponent(charts[0].dataUrl.split(',')[1]);
    expect(charts[0].title).toBe('Revenue');
    expect(svg).toContain('<rect');
    expect(svg).not.toMatch(/onload|<script|<image|href=/);
    container.remove();
  });
});
