import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { QueryResultArtifact } from '../../shared/types.js';

export interface ReportRequest { title: string; blocks: Record<string, unknown>[]; resultIds: string[]; format: 'html' | 'markdown' }
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const display = (value: unknown): string => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const mdCell = (value: unknown) => display(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const prose = (text: unknown) => renderToStaticMarkup(createElement(ReactMarkdown, { children: String(text ?? ''), remarkPlugins: [remarkGfm], skipHtml: true }));
function table(columns: string[], rows: Record<string, unknown>[], markdown: boolean): string {
  return markdown ? ['| ' + columns.map(mdCell).join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + columns.map(key => mdCell(row[key])).join(' | ') + ' |')].join('\n') : `<div class="table"><table><thead><tr>${columns.map(key => `<th>${escape(key)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(key => `<td>${escape(display(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Portable line/bar graphics; every chart also retains its exact evidence table. */
function chartSvg(block: Record<string, unknown>): string {
  const rows = block.rows as Record<string, unknown>[];
  const keys = block.valueKeys as string[];
  const name = String(block.nameKey ?? '');
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(keys) || !keys.length || !['line', 'bar', 'area'].includes(String(block.chartType))) return '';
  const values = rows.flatMap(row => keys.map(key => Number(row[key])).filter(Number.isFinite));
  if (!values.length || rows.length > 100) return '';
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const y = (value: number) => 270 - (value - low) / span * 230;
  const width = 640 / rows.length;
  const colors = ['#c8491d', '#526447', '#b08631', '#7b526b', '#536170'];
  const marks = keys.map((key, series) => {
    const color = colors[series % colors.length];
    if (block.chartType === 'bar') return rows.map((row, index) => {
      if (row[key] == null || !Number.isFinite(Number(row[key]))) return '';
      const value = Number(row[key]), baseline = y(0), top = y(value);
      return `<rect x="${60 + index * width + series * width / keys.length}" y="${Math.min(baseline, top)}" width="${Math.max(1, width / keys.length - 2)}" height="${Math.abs(top - baseline)}" fill="${color}"><title>${escape(row[name])}: ${escape(key)} ${escape(row[key])}</title></rect>`;
    }).join('');
    // Separate segments at NULLs instead of connecting across missing observations.
    let segment: string[] = []; const segments: string[] = [];
    for (const [index, row] of rows.entries()) {
      if (row[key] == null || !Number.isFinite(Number(row[key]))) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
      else segment.push(`${60 + (index + 0.5) * width},${y(Number(row[key]))}`);
    }
    if (segment.length) segments.push(segment.join(' '));
    return segments.map(points => `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`).join('');
  }).join('');
  const labels = rows.map((row, index) => index % Math.max(1, Math.ceil(rows.length / 6)) === 0 ? `<text x="${60 + (index + .5) * width}" y="295" text-anchor="middle">${escape(String(row[name] ?? '').slice(0, 18))}</text>` : '').join('');
  return `<figure><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escape(block.title ?? 'Data chart')}" viewBox="0 0 740 320"><line x1="60" y1="${y(0)}" x2="700" y2="${y(0)}" stroke="#d9d6cf"/><text x="8" y="44">${escape(high)}</text><text x="8" y="274">${escape(low)}</text>${marks}${labels}</svg><figcaption>${keys.map((key, index) => `<span style="color:${colors[index % colors.length]}">${escape(key)}</span>`).join(' · ')}${block.unit ? ' · ' + escape(block.unit) : ''}</figcaption></figure>`;
}

export function buildReportDownload(request: ReportRequest, artifacts: QueryResultArtifact[], generatedAt = new Date().toISOString()): string {
  const markdown = request.format === 'markdown';
  const heading = (text: unknown, level = 2) => markdown ? '#'.repeat(level) + ' ' + display(text) : `<h${level}>${escape(text)}</h${level}>`;
  const sections = request.blocks.filter((block, index) => !(index === 0 && block.type === 'heading' && block.text === request.title)).map(block => {
    if (block.type === 'heading') return heading(block.text, block.level === 3 ? 3 : 2);
    if (block.type === 'text') return markdown ? String(block.content ?? '') : prose(block.content);
    if (block.type === 'list') return markdown ? (block.items as unknown[]).map(item => '- ' + display(item)).join('\n') : `<ul>${(block.items as unknown[]).map(item => `<li>${escape(item)}</li>`).join('')}</ul>`;
    if (block.type === 'kpi') return markdown ? `**${mdCell(block.label)}:** ${mdCell(block.value)} ${mdCell(block.unit ?? '')}` : `<section class="kpi"><h3>${escape(block.label)}</h3><strong>${escape(display(block.value))}</strong> ${escape(block.unit)}</section>`;
    if (block.type === 'table' || block.type === 'chart') {
      const columns = block.columns as string[], rows = block.rows as Record<string, unknown>[];
      const data = Array.isArray(columns) && Array.isArray(rows) ? table(columns, rows, markdown) : '';
      const coverage = block.coverage as { truncated?: boolean; loadedRowCount?: number; returnedRowCount?: number } | undefined;
      const note = coverage?.truncated ? 'Limited preview; this table does not contain every matching record.' : 'Saved analytical result; see query evidence for scope.';
      return [heading(block.title ?? (block.type === 'chart' ? 'Visualization' : 'Data')), !markdown && block.type === 'chart' ? chartSvg(block) : '', data, markdown ? note : `<p class="meta">${note}</p>`].join('\n');
    }
    return '';
  }).join('\n\n');
  const evidence = artifacts.map(artifact => {
    const source = artifact.source;
    const detail = `${source?.label ?? 'Connected database'} (${source?.kind ?? 'source'}). Captured ${artifact.capturedAt ?? source?.capturedAt ?? 'time unavailable'}. ${artifact.result.rows.length} saved rows${artifact.result.truncated ? '; limited preview, not all matching data' : ''}.`;
    return [heading(artifact.purpose || artifact.queryId, 3), markdown ? detail : `<p>${escape(detail)}</p>`, markdown ? '```\n' + artifact.query.replaceAll('```', '` ` `') + '\n```' : `<pre><code>${escape(artifact.query)}</code></pre>`, table(artifact.result.columns, artifact.result.rows, markdown)].join('\n\n');
  }).join('\n\n');
  const meta = `Generated ${generatedAt}. Saved evidence snapshot; source data was not refreshed for this report. Data tables may be previews. Use a separate full-results export for all matching records.`;
  if (markdown) return `# ${request.title}\n\n${meta}\n\n${sections}\n\n## Sources and query evidence\n\n${evidence}\n`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(request.title)}</title><style>body{max-width:1000px;margin:48px auto;padding:0 24px;background:#fbfaf7;color:#17232d;font:16px/1.6 system-ui,sans-serif}h1,h2,h3{font-family:Georgia,serif;line-height:1.2}h1{font-size:36px}h2{margin-top:40px}p.meta,figcaption{color:#536170;font-size:13px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #d9d6cf;padding:10px;text-align:left;vertical-align:top}.table{overflow:auto}pre{padding:16px;background:#f4f0ea;white-space:pre-wrap;overflow-wrap:anywhere}.kpi strong{font-size:30px;font-variant-numeric:tabular-nums}svg{width:100%;height:auto;font:11px system-ui}figure{margin:24px 0}a{color:#a83a16}@media print{body{margin:0;max-width:none;background:white}h2,h3{break-after:avoid}tr,figure{break-inside:avoid}.table{overflow:visible}pre{font-size:11px}}</style></head><body><header><p>DB Chat · Analysis report</p><h1>${escape(request.title)}</h1><p class="meta">${escape(meta)}</p></header>${sections}<h2>Sources and query evidence</h2>${evidence}</body></html>`;
}
