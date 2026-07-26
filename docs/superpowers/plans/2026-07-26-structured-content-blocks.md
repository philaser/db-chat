# Structured Content Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw Markdown rendering for structured data with typed content blocks (table, chart, code, heading, list, text, divider) delimited by ` ```blocks ` fences.

**Architecture:** A ContentSplitter parses `message.content` for ` ```blocks ... ``` ` regions. Text outside blocks renders as normal Markdown. Each block inside dispatches to a dedicated React component (RichTableView, ChartBlock, CodeBlockView, etc.). The model is taught the format via system prompt additions.

**Tech Stack:** React, react-markdown, recharts (unchanged)

---

### Task 1: Create ContentSplitter utility

**Files:**
- Create: `src/renderer/components/ContentSplitter.ts`

- [ ] **Step 1: Create the ContentSplitter module**

```typescript
// src/renderer/components/ContentSplitter.ts
export interface ContentBlock {
  type: 'text' | 'heading' | 'table' | 'chart' | 'code' | 'list' | 'divider';
  [key: string]: unknown;
}

export interface ContentSegment {
  type: 'markdown' | 'blocks';
  content: string;
  blocks?: ContentBlock[];
}

export function splitContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /```blocks\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    // Text before this blocks block
    if (match.index > lastIndex) {
      segments.push({
        type: 'markdown',
        content: content.slice(lastIndex, match.index)
      });
    }

    // Parse the JSON array of blocks
    const jsonStr = match[1].trim();
    try {
      const blocks = JSON.parse(jsonStr) as ContentBlock[];
      segments.push({
        type: 'blocks',
        content: jsonStr,
        blocks
      });
    } catch {
      // If JSON is invalid, treat as plain markdown
      segments.push({
        type: 'markdown',
        content: match[0]
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last blocks block
  if (lastIndex < content.length) {
    segments.push({
      type: 'markdown',
      content: content.slice(lastIndex)
    });
  }

  return segments;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/ContentSplitter.ts
git commit -m "feat: add ContentSplitter utility for ```blocks parsing"
```

---

### Task 2: Create BlockRenderer component

**Files:**
- Create: `src/renderer/components/BlockRenderer.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Create BlockRenderer with all block view components**

```tsx
// src/renderer/components/BlockRenderer.tsx
import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  ScatterChart, Scatter, RadarChart, Radar, RadialBarChart, RadialBar,
  ComposedChart, FunnelChart, Funnel, Treemap, SunburstChart,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer
} from 'recharts';
import { Check, Copy } from 'lucide-react';
import type { ContentBlock } from './ContentSplitter.js';

// ── Rich Table ──────────────────────────────────────────────

function RichTableView({ block }: { block: ContentBlock }) {
  const columns = block.columns as string[] | undefined;
  const rows = block.rows as Record<string, unknown>[] | undefined;
  const columnTypes = block.columnTypes as Record<string, string> | undefined;

  if (!columns || !rows || columns.length === 0) {
    return null;
  }

  return (
    <div style={{ overflow: 'auto', margin: '8px 0' }}>
      <table className="content-block-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col} className={columnTypes?.[col] === 'number' ? 'numeric' : ''}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((col) => {
                const val = row[col];
                const isNumeric = columnTypes?.[col] === 'number';
                return (
                  <td key={col} className={isNumeric ? 'numeric' : val == null ? 'null' : ''}>
                    {val == null ? '\u2014' : String(val)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Code Block ──────────────────────────────────────────────

function CodeBlockView({ block }: { block: ContentBlock }) {
  const language = block.language as string | undefined;
  const content = block.content as string;
  const [copied, setCopied] = useState(false);

  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? 'code'}</span>
        <button
          type="button"
          className="code-block-copy"
          onClick={() => {
            navigator.clipboard.writeText(content).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="code-block-body">
        <code>{content}</code>
      </pre>
    </div>
  );
}

// ── List ────────────────────────────────────────────────────

function ListView({ block }: { block: ContentBlock }) {
  const ordered = block.ordered as boolean;
  const items = block.items as string[] | undefined;
  if (!items || items.length === 0) return null;

  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag style={{ paddingLeft: '20px', margin: '8px 0', lineHeight: '20px' }}>
      {items.map((item, i) => (
        <li key={i} style={{ margin: '2px 0' }}>{item}</li>
      ))}
    </Tag>
  );
}

// ── Heading ─────────────────────────────────────────────────

function HeadingView({ block }: { block: ContentBlock }) {
  const level = (block.level as number) ?? 2;
  const text = block.text as string;
  const Tag = `h${Math.min(Math.max(level, 1), 4)}` as keyof JSX.IntrinsicElements;
  const style: Record<number, React.CSSProperties> = {
    1: { fontSize: '18px', fontWeight: 650, lineHeight: '24px', margin: '16px 0 8px', color: 'var(--color-text-primary)' },
    2: { fontSize: '15px', fontWeight: 600, lineHeight: '22px', margin: '14px 0 6px', color: 'var(--color-text-primary)' },
    3: { fontSize: '13px', fontWeight: 600, lineHeight: '20px', margin: '12px 0 4px', color: 'var(--color-text-primary)' },
    4: { fontSize: '13px', fontWeight: 500, lineHeight: '20px', margin: '8px 0 4px', color: 'var(--color-text-secondary)' },
  };
  return <Tag style={style[level] ?? style[2]}>{text}</Tag>;
}

// ── Text ────────────────────────────────────────────────────

function TextBlockView({ block }: { block: ContentBlock }) {
  const content = block.content as string;
  return <p style={{ margin: '8px 0', lineHeight: '20px' }}>{content}</p>;
}

// ── Chart (reuses chart rendering logic from App.tsx) ──────

const FALLBACK_COLORS = ['var(--color-accept,#007aff)', 'var(--color-warning,#ff9f0a)', 'var(--color-success,#34c759)', 'var(--color-danger,#ff3b30)'];
const GRID = 'var(--color-separator,rgba(60,60,67,0.12))';
const TEXT = 'var(--color-text-secondary,#6e6e73)';

function ChartView({ block }: { block: ContentBlock }) {
  const chartType = block.chartType as string;
  const columns = block.columns as string[];
  const rows = block.rows as Record<string, unknown>[];
  const title = block.title as string | undefined;
  const nameKey = (block.nameKey as string) ?? columns?.[0];
  const valueKeys = (block.valueKeys as string[]) ?? (columns ? columns.filter((c) => c !== nameKey) : []);
  const series = block.series as Array<{ key: string; type?: string; name?: string }> | undefined;
  const options = block.options as Record<string, unknown> | undefined;
  const colors = (block.colors as string[]) ?? FALLBACK_COLORS;
  const stacked = options?.stacked === true;
  const isDonut = options?.donut === true;
  const layout = (options?.layout as string) ?? 'vertical';
  const showLegend = options?.showLegend !== false && valueKeys.length > 1;
  const showGrid = options?.showGrid !== false;

  if (!chartType || !columns || !rows) return null;

  function renderCartesianChart(ChartComponent: any, seriesRenderer: (key: string, i: number) => ReactNode, extraProps?: Record<string, unknown>) {
    const horizontal = layout === 'horizontal';
    return (
      <ChartComponent data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} {...extraProps}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={GRID} />}
        {!horizontal && <XAxis dataKey={nameKey} tick={{ fontSize: 11, fill: TEXT }} />}
        {horizontal && <YAxis dataKey={nameKey} type="category" tick={{ fontSize: 11, fill: TEXT }} />}
        {!horizontal && <YAxis tick={{ fontSize: 11, fill: TEXT }} />}
        {horizontal && <XAxis type="number" tick={{ fontSize: 11, fill: TEXT }} />}
        <RechartsTooltip />
        {showLegend && <Legend wrapperStyle={{ fontSize: '11px' }} />}
        {valueKeys.map((key, i) => seriesRenderer(key, i))}
      </ChartComponent>
    );
  }

  function renderChart(): ReactNode {
    switch (chartType) {
      case 'bar':
        return renderCartesianChart(BarChart, (key, i) => (
          <Bar key={key} dataKey={key} fill={colors[i % colors.length]} radius={[4, 4, 0, 0]} stackId={stacked ? 'stack' : undefined} />
        ), { layout: layout === 'horizontal' ? 'vertical' : undefined, barCategoryGap: '20%' });
      case 'line':
        return renderCartesianChart(LineChart, (key, i) => (
          <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={2} dot={{ fill: colors[i % colors.length], r: 3 }} />
        ));
      case 'area':
        return renderCartesianChart(AreaChart, (key, i) => (
          <Area key={key} type="monotone" dataKey={key} fill={colors[i % colors.length]} stroke={colors[i % colors.length]} fillOpacity={0.15} stackId={stacked ? 'stack' : undefined} />
        ));
      case 'composed':
        return renderCartesianChart(ComposedChart, (key, i) => {
          const s = series?.find((se) => se.key === key);
          const st = s?.type ?? 'bar';
          if (st === 'line') return <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={2} />;
          if (st === 'area') return <Area key={key} type="monotone" dataKey={key} fill={colors[i % colors.length]} stroke={colors[i % colors.length]} fillOpacity={0.2} />;
          return <Bar key={key} dataKey={key} fill={colors[i % colors.length]} radius={[3, 3, 0, 0]} />;
        });
      case 'scatter':
        return (
          <ScatterChart margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={GRID} />}
            <XAxis dataKey={valueKeys[0]} tick={{ fontSize: 11, fill: TEXT }} />
            <YAxis tick={{ fontSize: 11, fill: TEXT }} />
            <RechartsTooltip />
            {showLegend && <Legend wrapperStyle={{ fontSize: '11px' }} />}
            {valueKeys.slice(1).map((key, i) => (
              <Scatter key={key} data={rows} dataKey={key} fill={colors[i % colors.length]} name={key} />
            ))}
          </ScatterChart>
        );
      case 'pie':
        return (
          <PieChart>
            <Pie data={rows} dataKey={valueKeys[0]} nameKey={nameKey} cx="50%" cy="50%" innerRadius={isDonut ? 60 : 0} outerRadius={100} label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${percent != null ? (percent * 100).toFixed(0) : ''}%`} labelLine>
              {rows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
            <RechartsTooltip />
            {showLegend && <Legend wrapperStyle={{ fontSize: '11px' }} />}
          </PieChart>
        );
      case 'radialBar':
        return (
          <RadialBarChart data={rows} innerRadius={isDonut ? 30 : 0} outerRadius={120} startAngle={180} endAngle={0}>
            <RadialBar dataKey={valueKeys[0]} label={{ fill: TEXT, fontSize: 11, position: 'insideStart' }} background={{ fill: GRID }}>
              {rows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </RadialBar>
            <Legend wrapperStyle={{ fontSize: '11px' }} iconSize={10} />
            <RechartsTooltip />
          </RadialBarChart>
        );
      case 'radar':
        return (
          <RadarChart data={rows} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <PolarGrid stroke={GRID} />
            <PolarAngleAxis dataKey={nameKey} tick={{ fontSize: 11, fill: TEXT }} />
            <PolarRadiusAxis tick={{ fontSize: 10, fill: TEXT }} />
            <RechartsTooltip />
            {showLegend && <Legend wrapperStyle={{ fontSize: '11px' }} />}
            {valueKeys.map((key, i) => <Radar key={key} dataKey={key} stroke={colors[i % colors.length]} fill={colors[i % colors.length]} fillOpacity={0.15} />)}
          </RadarChart>
        );
      case 'funnel':
        return (
          <FunnelChart margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <RechartsTooltip />
            <Funnel dataKey={valueKeys[0]} nameKey={nameKey} data={rows} isAnimationActive>
              {rows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Funnel>
          </FunnelChart>
        );
      case 'treemap':
        return <Treemap data={rows} dataKey={valueKeys[0]} nameKey={nameKey} aspectRatio={4 / 3} stroke={GRID} fill={colors[0]} />;
      case 'sunburst':
        return <SunburstChart data={rows as never} dataKey={valueKeys[0]} nameKey={nameKey} />;
      default:
        return <p style={{ color: 'var(--color-danger)', fontSize: '12px' }}>Unknown chart type: {chartType}</p>;
    }
  }

  return (
    <div style={{ margin: '8px 0', padding: '12px', background: 'var(--color-control,rgba(250,250,252,0.92))', borderRadius: '8px' }}>
      {title && <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--color-text-primary)' }}>{title}</div>}
      <ResponsiveContainer width="100%" height={Math.min(320, Math.max(180, rows.length * 28 + 60))}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  );
}

// ── BlockRenderer ───────────────────────────────────────────

function BlockRenderer({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="content-blocks">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'text':
            return <TextBlockView key={i} block={block} />;
          case 'heading':
            return <HeadingView key={i} block={block} />;
          case 'table':
            return <RichTableView key={i} block={block} />;
          case 'chart':
            return <ChartView key={i} block={block} />;
          case 'code':
            return <CodeBlockView key={i} block={block} />;
          case 'list':
            return <ListView key={i} block={block} />;
          case 'divider':
            return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--color-separator)', margin: '16px 0' }} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

export { RichTableView, CodeBlockView, ChartView, BlockRenderer };
```

- [ ] **Step 2: Add CSS for block components**

Append to `src/renderer/styles.css`:

```css
/* ── Content Blocks ─────────────────────────────────────────── */

.content-blocks {
  width: 100%;
}

.content-block-table {
  border-collapse: collapse;
  font-size: 12px;
  line-height: 18px;
  min-width: 100%;
}

.content-block-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.content-block-table th {
  background: var(--color-control);
  border-bottom: 1px solid var(--color-separator);
  font-size: 11px;
  font-weight: 600;
  height: 34px;
  line-height: 16px;
  padding: 0 10px;
  text-align: left;
  white-space: nowrap;
}

.content-block-table th:first-child {
  padding-left: 14px;
}

.content-block-table th:last-child {
  padding-right: 14px;
}

.content-block-table th.numeric {
  text-align: right;
}

.content-block-table td {
  border-bottom: 1px solid var(--color-separator);
  height: 36px;
  line-height: 18px;
  max-width: 240px;
  overflow: hidden;
  padding: 0 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.content-block-table td:first-child {
  padding-left: 14px;
}

.content-block-table td:last-child {
  padding-right: 14px;
}

.content-block-table td.numeric {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.content-block-table td.null {
  color: var(--color-text-tertiary);
}

.content-block-table tbody tr:hover td {
  background: var(--color-control-hover);
}

/* ── Code Block ──────────────────────────────────────────────── */

.code-block-wrap {
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-control);
  margin: 8px 0;
  overflow: hidden;
}

.code-block-header {
  align-items: center;
  background: var(--color-control);
  border-bottom: 1px solid var(--color-separator);
  display: flex;
  height: 28px;
  justify-content: space-between;
  padding: 0 10px;
}

.code-block-lang {
  color: var(--color-text-tertiary);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
}

.code-block-copy {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-row);
  color: var(--color-text-tertiary);
  cursor: pointer;
  display: flex;
  height: 20px;
  justify-content: center;
  padding: 0;
  transition: color var(--motion-fast) var(--ease-standard);
  width: 20px;
}

.code-block-copy:hover {
  color: var(--color-text-primary);
}

.code-block-body {
  background: var(--code-bg);
  color: var(--code-text);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 18px;
  margin: 0;
  overflow: auto;
  padding: 10px;
}

.code-block-body code {
  background: transparent;
  border: none;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  padding: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/BlockRenderer.tsx src/renderer/styles.css
git commit -m "feat: add BlockRenderer, RichTableView, CodeBlockView, ChartView components"
```

---

### Task 3: Wire BlockRenderer into App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add imports for ContentSplitter and BlockRenderer**

At the top of App.tsx, add:

```typescript
import { splitContent, type ContentSegment, type ContentBlock } from './components/ContentSplitter.js';
import { BlockRenderer } from './components/BlockRenderer.js';
```

- [ ] **Step 2: Update the message rendering to use BlockRenderer**

Find the `ReactMarkdown` invocation inside the transcript loop (near line 3176 in the message rendering section). Replace the current ReactMarkdown block with:

```tsx
<div className="transcript-content">
  {(() => {
    const segments = splitContent(message.content);
    return segments.map((seg, segIndex) => {
      if (seg.type === 'blocks' && seg.blocks) {
        return <BlockRenderer key={segIndex} blocks={seg.blocks} />;
      }
      // For chart-only backward compatibility, also check if this is a ```chart block
      if (seg.type === 'markdown') {
        const chartMatch = seg.content.match(/```chart\s*\n([\s\S]*?)```/);
        if (chartMatch) {
          try {
            const chartSpec = JSON.parse(chartMatch[1]);
            return <ChartBlock key={segIndex} spec={JSON.stringify(chartSpec)} />;
          } catch {
            // fall through to normal markdown
          }
        }
      }
      return (
        <ReactMarkdown
          key={segIndex}
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {seg.content}
        </ReactMarkdown>
      );
    });
  })()}
  ...
```

Note: Keep the existing `markdownComponents` and `MemoChartBlock` as-is for now for backward compatibility with old ` ```chart ` blocks.

- [ ] **Step 3: Remove unused imports if any (ReactMarkdown may still be needed)**

Keep ReactMarkdown and remarkGfm imports — they are still used for markdown segments. Keep recharts imports — they are still used by the ChartView in BlockRenderer. Actually, since ChartView is now in BlockRenderer.tsx, we can remove recharts imports from App.tsx. But let me check... ChartView is in BlockRenderer.tsx which has its own imports. So we can remove the recharts imports from App.tsx.

But wait - the existing `ChartBlock` and `MemoChartBlock` and `markdownComponents` are still in App.tsx for backward compatibility (old ```chart blocks). So we need to keep the recharts imports in App.tsx too. Actually, let me simplify: keep them in App.tsx for now, we can clean up later.

Actually, looking at the code more carefully, the `ChartBlock` component in App.tsx uses Recharts components directly. Since we're keeping backward compatibility, we need those imports in App.tsx. Let me leave them.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: wire BlockRenderer into message rendering pipeline"
```

---

### Task 4: Update system prompt with block format instructions

**Files:**
- Modify: `src/main/agent/prompts/system.ts`

- [ ] **Step 1: Add Content Format section to system prompt**

Find the `chartGuidelines` variable and the section where guidelines are assembled. Add a new block format guideline section:

```typescript
const blockFormatGuidelines =
    '## Content Blocks\n\n' +
    'You can present structured data (tables, charts, code) using typed content blocks.\n' +
    'Wrap a JSON array of block objects in a fenced code block with language "blocks":\n\n' +
    '  ```blocks\n' +
    '  [\n' +
    '    {"type":"table","columns":["Name","Value"],"columnTypes":{"Value":"number"},"rows":[{"Name":"A","Value":10}]},\n' +
    '    {"type":"code","language":"sql","content":"SELECT * FROM users"}\n' +
    '  ]\n' +
    '  ```\n\n' +
    'Block types:\n' +
    '- table: columns + rows of data. Set columnTypes for numeric alignment.\n' +
    '- chart: chart specification. Use visualize_data and include its output directly.\n' +
    '- code: code snippet with language annotation.\n' +
    '- heading: section heading with level (1-4) and text.\n' +
    '- list: ordered (true/false) list of items.\n' +
    '- text: rich text paragraph (inline Markdown).\n' +
    '- divider: horizontal separator.\n' +
    'Use blocks for any structured data. Regular prose should remain as plain Markdown outside blocks.';
```

Then add it to the return array:

```typescript
    `\n## Chart Generation\n\n${chartGuidelines}`,

    `\n\n${blockFormatGuidelines}`
```

- [ ] **Step 2: Commit**

```bash
git add src/main/agent/prompts/system.ts
git commit -m "feat: add content block format instructions to system prompt"
```

---

### Task 5: Verify backward compatibility

**Files:**
- Test by running typecheck, build, and tests

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors. If there are import errors, fix them.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All 38 tests pass.

- [ ] **Step 4: Verify old ```chart blocks still work**

In `src/renderer/App.tsx`, the backward compatibility code in the message renderer checks for ```chart blocks in markdown segments and renders them via the old ChartBlock. Verify this path is still reachable.

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore: finalize structured content blocks implementation"
```
