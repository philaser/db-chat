import { memo, useState, type CSSProperties } from 'react';
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

  if (!columns || !rows || columns.length === 0) return null;

  return (
    <div style={{ overflow: 'auto', margin: '8px 0' }}>
      <table className="content-block-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col} className={columnTypes?.[col] === 'number' ? 'numeric' : ''}>{col}</th>
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

const MemoRichTable = memo(RichTableView);

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

const MemoCodeBlock = memo(CodeBlockView);

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
  const level = Math.min(Math.max((block.level as number) ?? 2, 1), 4);
  const text = block.text as string;
  const style: Record<number, CSSProperties> = {
    1: { fontSize: '18px', fontWeight: 650, lineHeight: '24px', margin: '16px 0 8px', color: 'var(--color-text-primary)' },
    2: { fontSize: '15px', fontWeight: 600, lineHeight: '22px', margin: '14px 0 6px', color: 'var(--color-text-primary)' },
    3: { fontSize: '13px', fontWeight: 600, lineHeight: '20px', margin: '12px 0 4px', color: 'var(--color-text-primary)' },
    4: { fontSize: '13px', fontWeight: 500, lineHeight: '20px', margin: '8px 0 4px', color: 'var(--color-text-secondary)' },
  };
  return <div style={style[level] ?? style[2]}>{text}</div>;
}

// ── Text ────────────────────────────────────────────────────

function TextBlockView({ block }: { block: ContentBlock }) {
  return <p style={{ margin: '8px 0', lineHeight: '20px', color: 'var(--color-text-primary)' }}>{block.content as string}</p>;
}

// ── Chart ───────────────────────────────────────────────────

const FALLBACK_COLORS = ['var(--color-accept,#007aff)', 'var(--color-warning,#ff9f0a)', 'var(--color-success,#34c759)', 'var(--color-danger,#ff3b30)'];
const GRID = 'var(--color-separator,rgba(60,60,67,0.12))';
const TEXT = 'var(--color-text-secondary,#6e6e73)';

function ChartView({ block }: { block: ContentBlock }) {
  const chartType = block.chartType as string;
  const columns = block.columns as string[] | undefined;
  const rows = block.rows as Record<string, unknown>[] | undefined;
  const title = block.title as string | undefined;
  const nameKey = (block.nameKey as string) ?? columns?.[0] ?? '';
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
  const safeRows = rows;

  function renderCartesianChart(ChartComponent: any, seriesRenderer: (key: string, i: number) => ReactNode, extraProps?: Record<string, unknown>) {
    const horizontal = layout === 'horizontal';
    return (
      <ChartComponent data={safeRows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} {...extraProps}>
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
                <Scatter key={key} data={safeRows} dataKey={key} fill={colors[i % colors.length]} name={key} />
              ))}
            </ScatterChart>
        );
      case 'pie':
        return (
          <PieChart>
            <Pie data={rows} dataKey={valueKeys[0]} nameKey={nameKey} cx="50%" cy="50%" innerRadius={isDonut ? 60 : 0} outerRadius={100}
              label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${percent != null ? (percent * 100).toFixed(0) : ''}%`} labelLine>
              {safeRows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Pie>
            <RechartsTooltip />
            {showLegend && <Legend wrapperStyle={{ fontSize: '11px' }} />}
          </PieChart>
        );
      case 'radialBar':
        return (
          <RadialBarChart data={rows} innerRadius={isDonut ? 30 : 0} outerRadius={120} startAngle={180} endAngle={0}>
            <RadialBar dataKey={valueKeys[0]} label={{ fill: TEXT, fontSize: 11, position: 'insideStart' }} background={{ fill: GRID }}>
              {safeRows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
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
              {safeRows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
            </Funnel>
          </FunnelChart>
        );
      case 'treemap':
        return <Treemap data={safeRows} dataKey={valueKeys[0]} nameKey={nameKey} aspectRatio={4 / 3} stroke={GRID} fill={colors[0]} />;
      case 'sunburst':
        return <SunburstChart data={safeRows as never} dataKey={valueKeys[0]} nameKey={nameKey} />;
      default:
        return <p style={{ color: 'var(--color-danger)', fontSize: '12px' }}>Unknown chart type: {chartType}</p>;
    }
  }

  return (
    <div style={{ margin: '8px 0', padding: '12px', background: 'var(--color-control,rgba(250,250,252,0.92))', borderRadius: '8px' }}>
      {title && <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--color-text-primary)' }}>{title}</div>}
      <ResponsiveContainer width="100%" height={Math.min(320, Math.max(180, safeRows.length * 28 + 60))}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  );
}

const MemoChart = memo(ChartView);

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
            return <MemoRichTable key={i} block={block} />;
          case 'chart':
            return <MemoChart key={i} block={block} />;
          case 'code':
            return <MemoCodeBlock key={i} block={block} />;
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

export { BlockRenderer, RichTableView, CodeBlockView, ChartView };
