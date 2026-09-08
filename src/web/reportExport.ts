import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, QueryResultArtifact } from '../shared/types.js';

export interface ReportChart { title: string; dataUrl: string }
export interface AnswerReportOptions {
  title: string;
  messages: ChatMessage[];
  artifacts: QueryResultArtifact[];
  format: 'html' | 'markdown';
  charts?: ReportChart[];
  generatedAt?: string;
}
const escape = (value: unknown) => String(value ?? '—').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const cell = (value: unknown) => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
const mdCell = (value: unknown) => cell(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

function narrative(content: string): string {
  // Chart/table values are exported from query artifacts, not reconstructed JSON prose.
  return content.replace(/```(?:chart|blocks|report)\s*\n([\s\S]*?)```/g, (_block, json: string) => {
    try {
      const parsed: unknown = JSON.parse(json);
      const blocks = Array.isArray(parsed) ? parsed : [parsed];
      return blocks.flatMap((block: unknown) => {
        if (!block || typeof block !== 'object') return [];
        const value = block as Record<string, unknown>;
        if (value.type === 'heading') return ['## ' + String(value.text ?? '')];
        if (value.type === 'text') return [String(value.content ?? '')];
        if (value.type === 'list' && Array.isArray(value.items)) return [value.items.map(item => '- ' + String(item)).join('\n')];
        if (value.type === 'metric' || value.type === 'kpi') return ['**' + String(value.label ?? '') + ': ' + cell(value.value) + (value.unit ? ' ' + String(value.unit) : '') + '**'];
        if (value.type === 'clarification') return [String(value.question ?? '')];
        if (typeof value.title === 'string') return ['### ' + value.title];
        return [];
      }).join('\n\n');
    } catch { return '\n[Structured output was incomplete. See the saved evidence below.]\n'; }
  });
}

/** Capture the app's existing Recharts output for portable, offline reports. */
export function collectReportCharts(root: Element): ReportChart[] {
  return Array.from(root.querySelectorAll<SVGSVGElement>('svg.recharts-surface')).map((svg, index) => {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
    const copies = [copy, ...Array.from(copy.querySelectorAll('*'))];
    for (let i = 0; i < copies.length; i++) {
      const element = copies[i];
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name) || /href/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
      if (originals[i]) {
        const style = getComputedStyle(originals[i]);
        for (const property of ['fill', 'stroke', 'font-family', 'font-size', 'font-weight']) {
          const value = style.getPropertyValue(property);
          if (value && !value.includes('url(')) element.setAttribute(property, value);
        }
      }
    }
    copy.querySelectorAll('script,foreignObject,image,use,a').forEach(element => element.remove());
    const label = svg.closest('figure')?.getAttribute('aria-label')?.replace(/^Chart:\s*/, '') ?? `Chart ${index + 1}`;
    return { title: label, dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy)) };
  });
}

export function buildAnswerReport(options: AnswerReportOptions): string {
  const timestamp = options.generatedAt ?? new Date().toISOString();
  const messages = options.messages.filter(message => message.role !== 'system');
  const artifacts = options.artifacts.filter((artifact, index, all) => all.findIndex(item => item.queryId === artifact.queryId) === index);
  if (options.format === 'markdown') {
    return ['# ' + options.title, `Exported ${timestamp}. Saved snapshot; data was not refreshed.`,
      ...messages.map(message => `## ${message.role === 'user' ? 'Question' : 'Answer'}\n\n${narrative(message.content)}`),
      '## Query evidence', ...artifacts.map(artifact => {
        const source = artifact.source;
        return [`### ${artifact.purpose || artifact.queryId}`, source ? `Source: ${source.label} (${source.kind}). Captured ${source.capturedAt}.` : 'Source identity was not captured for this older result.',
          `${artifact.result.rowCount} saved rows${artifact.result.truncated ? ' — limited preview, not the complete dataset' : ''}.`,
          '```sql\n' + artifact.query.replace(/```/g, '` ` `') + '\n```',
          ['| ' + artifact.result.columns.map(mdCell).join(' | ') + ' |', '| ' + artifact.result.columns.map(() => '---').join(' | ') + ' |',
          ...artifact.result.rows.map(row => '| ' + artifact.result.columns.map(column => mdCell(row[column])).join(' | ') + ' |')].join('\n')].join('\n\n');
      })].join('\n\n') + '\n';
  }
  const content = messages.map(message => `<section><h2>${message.role === 'user' ? 'Question' : 'Answer'}</h2>${renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: narrative(message.content) }))}</section>`).join('');
  const evidence = artifacts.map(artifact => `<section class="evidence"><h2>${escape(artifact.purpose || artifact.queryId)}</h2><p>${artifact.source ? `${escape(artifact.source.label)} · ${escape(artifact.source.kind)} · Captured ${escape(artifact.source.capturedAt)}` : 'Source identity was not captured for this older result.'}</p><p>${artifact.result.rowCount} saved rows${artifact.result.truncated ? ' · Limited preview — not the complete dataset' : ''}</p><pre><code>${escape(artifact.query)}</code></pre><div class="table-scroll"><table><thead><tr>${artifact.result.columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${artifact.result.rows.map(row => `<tr>${artifact.result.columns.map(column => `<td>${escape(cell(row[column]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`).join('');
  const charts = (options.charts ?? []).filter(chart => chart.dataUrl.startsWith('data:image/svg+xml;charset=utf-8,')).map(chart => `<figure><img alt="${escape(chart.title)}" src="${escape(chart.dataUrl)}"><figcaption>${escape(chart.title)}</figcaption></figure>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escape(options.title)}</title><style>body{max-width:1000px;margin:48px auto;padding:0 24px;background:#fbfaf7;color:#17232d;font:16px/1.6 system-ui,sans-serif}h1,h2,h3{font-family:Georgia,serif;line-height:1.2}h1{font-size:36px}h2{margin-top:32px}p.meta{color:#536170}section{margin:32px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #d9d6cf;padding:10px;text-align:left;vertical-align:top}pre{padding:16px;background:#f4f0ea;white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:32px 0}figcaption{color:#536170}.table-scroll{overflow:auto}a{color:#a83a16}@media print{body{margin:0;max-width:none;background:white}h2,h3{break-after:avoid}tr,figure{break-inside:avoid}.table-scroll{overflow:visible}pre{font-size:11px}}</style></head><body><header><p>DB Chat · Analysis report</p><h1>${escape(options.title)}</h1><p class="meta">Exported ${escape(timestamp)}. Saved snapshot; data was not refreshed.</p></header>${content}${charts}<h1>Query evidence</h1>${evidence}<footer><p>Read-only analysis. Interpret results with the stated definitions, limits and source context.</p></footer></body></html>`;
}
