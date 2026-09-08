import { useRef, useState, type ReactNode } from 'react';
import { ChartViewMemo } from './chartRenderer.js';
import { readableColumnLabel } from './formatting.js';

export interface ContentBlock {
  type: 'text' | 'heading' | 'table' | 'chart' | 'code' | 'list' | 'divider' | 'kpi' | 'clarification';
  [key: string]: unknown;
}

export interface ContentSegment {
  type: 'markdown' | 'blocks' | 'pending';
  content: string;
  blocks?: ContentBlock[];
}

const BLOCK_TYPES = new Set<ContentBlock['type']>([
  'text',
  'heading',
  'table',
  'chart',
  'code',
  'list',
  'divider'
  ,'kpi'
  ,'clarification'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string' || !BLOCK_TYPES.has(value.type as ContentBlock['type'])) return false;
  if (value.type === 'table') {
    return Array.isArray(value.columns)
      && value.columns.length > 0
      && value.columns.every((column) => typeof column === 'string')
      && Array.isArray(value.rows)
      && value.rows.every(isRecord);
  }
  if (value.type === 'chart') {
    return typeof value.chartType === 'string'
      && Array.isArray(value.columns)
      && value.columns.length > 0
      && value.columns.every((column) => typeof column === 'string')
      && Array.isArray(value.rows)
      && value.rows.length > 0
      && value.rows.every(isRecord);
  }
  if (value.type === 'text' || value.type === 'heading') return typeof value.type === 'string' && typeof (value.type === 'text' ? value.content : value.text) === 'string';
  if (value.type === 'kpi') return typeof value.label === 'string' && (value.value === null || typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') && typeof value.resultId === 'string';
  if (value.type === 'clarification') return typeof value.question === 'string' && (value.choices === undefined || (Array.isArray(value.choices) && value.choices.every((choice) => typeof choice === 'string')));
  if (value.type === 'code') return typeof value.content === 'string';
  if (value.type === 'list') return Array.isArray(value.items) && value.items.every((item) => typeof item === 'string');
  return true;
}

function normalizeBlocks(parsed: unknown): ContentBlock[] | null {
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  if (candidates.length === 0) return null;
  const blocks = candidates.map((candidate) => {
    if (isContentBlock(candidate)) return candidate;
    if (isRecord(candidate) && typeof candidate.chartType === 'string') {
      return { ...candidate, type: 'chart' } as ContentBlock;
    }
    return null;
  });
  return blocks.every((block): block is ContentBlock => block !== null) ? blocks : null;
}

export function parseContentBlocks(value: string): ContentBlock[] | null {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return normalizeBlocks(parsed);
  } catch {
    return null;
  }
}

function findJsonEnd(source: string, start: number): number | null {
  const first = source[start];
  if (first !== '[' && first !== '{') return null;
  const stack = [first === '[' ? ']' : '}'];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') stack.push(']');
    else if (character === '{') stack.push('}');
    else if (character === ']' || character === '}') {
      if (character !== stack[stack.length - 1]) return null;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }

  return null;
}

function splitRawBlocks(markdown: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let cursor = 0;
  let searchIndex = 0;

  while (searchIndex < markdown.length) {
    const nextArray = markdown.indexOf('[', searchIndex);
    const nextObject = markdown.indexOf('{', searchIndex);
    const starts = [nextArray, nextObject].filter((index) => index >= 0);
    if (starts.length === 0) break;

    const start = Math.min(...starts);
    const end = findJsonEnd(markdown, start);
    if (end === null) {
      const candidate = markdown.slice(start).trimStart();
      if (/^[\[{]\s*(?:"(?:type|chartType)|$)/.test(candidate)) {
        if (start > cursor) segments.push({ type: 'markdown', content: markdown.slice(cursor, start) });
        segments.push({ type: 'pending', content: candidate });
        cursor = markdown.length;
        break;
      }
      searchIndex = start + 1; continue;
    }

    const blocks = parseContentBlocks(markdown.slice(start, end));
    if (!blocks) {
      searchIndex = start + 1;
      continue;
    }

    if (start > cursor) segments.push({ type: 'markdown', content: markdown.slice(cursor, start) });
    segments.push({ type: 'blocks', content: markdown.slice(start, end), blocks });
    cursor = end;
    searchIndex = end;
  }

  if (cursor < markdown.length) segments.push({ type: 'markdown', content: markdown.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: 'markdown', content: markdown }];
}

export function splitContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    segments.push(...splitRawBlocks(content.slice(lastIndex, match.index)));
    const json = match[2].trim();
    const blocks = parseContentBlocks(json);
    if (blocks) segments.push({ type: 'blocks', content: json, blocks });
    else segments.push({ type: 'markdown', content: match[0] });
    lastIndex = match.index + match[0].length;
  }

  segments.push(...splitRawBlocks(content.slice(lastIndex)));
  return segments.filter((segment) => segment.content.length > 0);
}

function formatBlockValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function coverageLabel(block: ContentBlock, displayedRows: number): string | null {
  if (!isRecord(block.coverage)) return null;
  const loaded = typeof block.coverage.loadedRowCount === 'number' ? block.coverage.loadedRowCount : displayedRows;
  const returned = typeof block.coverage.returnedRowCount === 'number' ? block.coverage.returnedRowCount : displayedRows;
  const total = typeof block.coverage.totalRowCount === 'number' ? block.coverage.totalRowCount : null;
  const limited = block.coverage.truncated === true || block.coverage.totalRowCount === null;
  if (returned >= loaded && !limited && (total === null || loaded >= total)) return null;
  let label = returned < loaded
    ? `Showing ${returned.toLocaleString()} of ${loaded.toLocaleString()} rows`
    : `Showing ${loaded.toLocaleString()} loaded ${loaded === 1 ? 'row' : 'rows'}`;
  if (limited) label += '; source result was limited';
  else if (total !== null && total > loaded) label += ` of ${total.toLocaleString()} total`;
  return label;
}

function TableBlock({ block }: { block: ContentBlock }): ReactNode {
  const columns = block.columns as string[];
  const rows = block.rows as Record<string, unknown>[];
  const columnTypes = isRecord(block.columnTypes) ? block.columnTypes as Record<string, unknown> : undefined;
  const coverage = coverageLabel(block, rows.length);

  return (
    <div className="assistant-content-table-wrap">
      <table className="assistant-content-table">
        {coverage && <caption>{coverage}</caption>}
        <thead>
          <tr>{columns.map((column) => <th key={column} scope="col" title={column} className={columnTypes?.[column] === 'number' ? 'numeric' : undefined}>{readableColumnLabel(column)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const value = row[column];
                const numeric = columnTypes?.[column] === 'number' || typeof value === 'number';
                const empty = value === null || value === undefined;
                return <td key={column} className={numeric ? 'numeric' : empty ? 'null' : undefined} title={formatBlockValue(value)}>{formatBlockValue(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InteractiveChartBlock({ block }: { block: ContentBlock }) {
  const columns = Array.isArray(block.columns) ? block.columns.filter((column): column is string => typeof column === 'string') : [];
  const rows = Array.isArray(block.rows) ? block.rows.filter(isRecord) : [];
  const numeric = columns.filter((column) => rows.some((row) => typeof row[column] === 'number'));
  const [chartType, setChartType] = useState(String(block.chartType ?? 'bar'));
  const [nameKey, setNameKey] = useState(String(block.nameKey ?? columns.find((column) => !numeric.includes(column)) ?? columns[0] ?? ''));
  const [metric, setMetric] = useState(String((Array.isArray(block.valueKeys) ? block.valueKeys[0] : undefined) ?? numeric[0] ?? ''));
  const root = useRef<HTMLDivElement>(null);
  const download = () => {
    const svg = root.current?.querySelector('svg'); if (!svg) return;
    const copy = svg.cloneNode(true) as SVGElement; copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${String(block.title ?? 'chart').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.svg`; anchor.click(); URL.revokeObjectURL(url);
  };
  const editable = ['bar', 'line', 'area', 'pie'].includes(chartType);
  const safeType = editable ? chartType : String(block.chartType);
  const coverage = coverageLabel(block, rows.length);
  return <div className="interactive-chart" ref={root}>
    <div className="chart-controls" aria-label="Chart display controls">
      {editable && <><label>Type<select value={safeType} onChange={(event) => setChartType(event.target.value)}><option value="bar">Bar</option><option value="line">Line</option><option value="area">Area</option><option value="pie">Pie</option></select></label>
      <label>Group<select value={nameKey} onChange={(event) => setNameKey(event.target.value)}>{columns.map((column) => <option key={column} value={column} title={column}>{readableColumnLabel(column)}</option>)}</select></label>
      <label>Metric<select value={metric} onChange={(event) => setMetric(event.target.value)}>{numeric.map((column) => <option key={column} value={column} title={column}>{readableColumnLabel(column)}</option>)}</select></label></>}
      <button type="button" onClick={download}>Download SVG</button>
    </div>
    <p className="chart-control-note">Display changes use this saved result and do not query the database.</p>
    <ChartViewMemo block={editable ? { ...block, chartType: safeType, nameKey, valueKeys: [metric] } : block} />
    {coverage && <p className="result-coverage">{coverage}</p>}
  </div>;
}

function renderBlock(block: ContentBlock, index: number): ReactNode {
  switch (block.type) {
    case 'table':
      return <TableBlock key={index} block={block} />;
    case 'chart':
      return <InteractiveChartBlock key={index} block={block} />;
    case 'heading': {
      const level = Math.min(4, Math.max(2, Number(block.level) || 2));
      const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
      return <Heading key={index} className="assistant-content-heading">{String(block.text)}</Heading>;
    }
    case 'text':
      return <p key={index} className="assistant-content-text">{String(block.content)}</p>;
    case 'list': {
      const List = block.ordered === true ? 'ol' : 'ul';
      return <List key={index} className="assistant-content-list">{(block.items as string[]).map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</List>;
    }
    case 'code':
      return <pre key={index} className="assistant-content-code"><code>{String(block.content)}</code></pre>;
    case 'divider':
      return <hr key={index} className="assistant-content-divider" />;
    case 'kpi':
      return <div key={index} className="assistant-kpi" aria-label={`${String(block.label)}: ${formatBlockValue(block.value)}`}><span>{String(block.label)}</span><strong>{formatBlockValue(block.value)}{block.value !== null && block.value !== undefined && block.unit ? <small> {String(block.unit)}</small> : null}</strong></div>;
    case 'clarification':
      return <div key={index} className="assistant-clarification"><strong>{String(block.question)}</strong>{Array.isArray(block.choices) && <div>{block.choices.map((choice) => <button type="button" key={String(choice)} onClick={() => window.dispatchEvent(new CustomEvent('dbchat:clarification', { detail: String(choice) }))}>{String(choice)}</button>)}</div>}</div>;
    default:
      return null;
  }
}

export function StructuredContent({ blocks }: { blocks: ContentBlock[] }): ReactNode {
  return <div className="assistant-structured-content">{blocks.map(renderBlock)}</div>;
}
