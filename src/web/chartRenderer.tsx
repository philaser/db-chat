import { memo, useEffect, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  SunburstChart,
  Tooltip as RechartsTooltip,
  Treemap,
  XAxis,
  YAxis,
  LabelList
} from 'recharts';
import type { ContentBlock } from './contentBlocks.js';
import type { ChartAnnotation } from '../shared/chart.js';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)'
];
const CHART_HEIGHT = 260;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: unknown; color?: string }>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="assistant-chart-tooltip">
      {label !== undefined && <div className="assistant-chart-tooltip-label">{String(label)}</div>}
      {payload.map((entry, index) => (
        <div className="assistant-chart-tooltip-row" key={String(entry.name ?? index)}>
          <span>{String(entry.name ?? 'Value')}</span>
          <strong>{String(entry.value ?? '—')}</strong>
        </div>
      ))}
    </div>
  );
}

function formatChartValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}

function renderAnnotations(annotations: ChartAnnotation[]): ReactNode[] {
  return annotations.flatMap((annotation, index) => {
    const color = annotation.color ?? 'var(--rust)';
    const label = annotation.text
      ? { value: annotation.text, fill: color, fontFamily: 'var(--font-sans)', fontSize: 11, position: annotation.position ?? 'top' }
      : undefined;

    if ((annotation.kind === 'point' || annotation.kind === 'label') && annotation.x !== undefined && annotation.y !== undefined) {
      return [
        <ReferenceDot
          key={`annotation-point-${index}`}
          x={annotation.x}
          y={annotation.y}
          r={annotation.kind === 'label' ? 0 : 4}
          fill={color}
          stroke={color}
          label={label}
        />
      ];
    }

    if (annotation.kind === 'line') {
      if (annotation.x1 !== undefined && annotation.x2 !== undefined && annotation.y1 !== undefined && annotation.y2 !== undefined) {
        return [
          <ReferenceLine
            key={`annotation-segment-${index}`}
            segment={[{ x: annotation.x1, y: annotation.y1 }, { x: annotation.x2, y: annotation.y2 }]}
            stroke={color}
            strokeWidth={1.25}
            label={label}
          />
        ];
      }
      if (annotation.x !== undefined) {
        return [<ReferenceLine key={`annotation-x-${index}`} x={annotation.x} stroke={color} label={label} />];
      }
      if (annotation.y !== undefined) {
        return [<ReferenceLine key={`annotation-y-${index}`} y={annotation.y} stroke={color} label={label} />];
      }
    }

    if (annotation.kind === 'range' && annotation.x1 !== undefined && annotation.x2 !== undefined) {
      return [
        <ReferenceArea
          key={`annotation-range-${index}`}
          x1={annotation.x1}
          x2={annotation.x2}
          y1={annotation.y1}
          y2={annotation.y2}
          fill={color}
          fillOpacity={0.08}
          stroke={color}
          strokeOpacity={0.3}
          label={label}
        />
      ];
    }

    return [];
  });
}

function distributeLabelPositions(values: number[], top: number, bottom: number, gap: number): number[] {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const positioned: Array<{ index: number; value: number }> = [];
  let previous = top - gap;

  for (const item of ordered) {
    const value = Math.max(item.value, previous + gap);
    positioned.push({ index: item.index, value });
    previous = value;
  }

  const overflow = Math.max(0, (positioned.at(-1)?.value ?? bottom) - bottom);
  if (overflow > 0) {
    positioned.forEach((item) => { item.value -= overflow; });
  }

  const underflow = Math.max(0, top - (positioned[0]?.value ?? top));
  if (underflow > 0) {
    positioned.forEach((item) => { item.value += underflow; });
  }

  const result = values.map(() => top);
  positioned.forEach((item) => { result[item.index] = item.value; });
  return result;
}

function SlopeChart({
  title,
  rows,
  nameKey,
  valueKeys,
  options,
  annotations
}: {
  title?: string;
  rows: Record<string, unknown>[];
  nameKey: string;
  valueKeys: string[];
  options: Record<string, unknown>;
  annotations: ChartAnnotation[];
}) {
  const points = rows.map((row) => ({
    name: String(row[nameKey] ?? ''),
    start: Number(row[valueKeys[0]]),
    end: Number(row[valueKeys[1]])
  })).filter((point) => point.name && Number.isFinite(point.start) && Number.isFinite(point.end));

  if (points.length === 0) return <p className="assistant-chart-error">This slope chart could not be rendered.</p>;

  const leftX = 198;
  const rightX = 638;
  const topY = 44;
  const bottomY = 244;
  const allValues = points.flatMap((point) => [point.start, point.end]);
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const spread = Math.max(maxValue - minValue, 1);
  const domainMin = minValue - spread * 0.08;
  const domainMax = maxValue + spread * 0.08;
  const yFor = (value: number) => bottomY - ((value - domainMin) / (domainMax - domainMin)) * (bottomY - topY);
  const startLabel = String(options.startLabel ?? valueKeys[0]);
  const endLabel = String(options.endLabel ?? valueKeys[1]);
  const nameYs = distributeLabelPositions(points.map((point) => (yFor(point.start) + yFor(point.end)) / 2), topY, bottomY, 16);
  const startValueYs = distributeLabelPositions(points.map((point) => yFor(point.start)), topY, bottomY, 14);
  const endValueYs = distributeLabelPositions(points.map((point) => yFor(point.end)), topY, bottomY, 14);

  return (
    <svg className="assistant-chart-slope" viewBox="0 0 760 280" role="img" aria-label={title ? `Slope chart: ${title}` : 'Slope chart'}>
      <title>{title ?? 'Slope chart'}</title>
      <text x={leftX} y={22} textAnchor="middle" className="assistant-chart-slope-heading">{startLabel}</text>
      <text x={rightX} y={22} textAnchor="middle" className="assistant-chart-slope-heading">{endLabel}</text>
      {points.map((point, index) => {
        const startY = yFor(point.start);
        const endY = yFor(point.end);
        const rising = point.end >= point.start;
        const color = rising ? 'var(--chart-1)' : 'var(--chart-2)';
        return (
          <g key={`${point.name}-${index}`}>
            <line x1={leftX} y1={startY} x2={rightX} y2={endY} stroke={color} className="assistant-chart-slope-connector" />
            <circle cx={leftX} cy={startY} r={4.5} fill={color} />
            <circle cx={rightX} cy={endY} r={4.5} fill={color} />
            <text x={18} y={nameYs[index] + 4} className="assistant-chart-slope-name">{point.name}</text>
            <text x={leftX - 12} y={startValueYs[index] + 4} textAnchor="end" className="assistant-chart-slope-value">{formatChartValue(point.start)}</text>
            <text x={rightX + 12} y={endValueYs[index] + 4} className="assistant-chart-slope-value">{formatChartValue(point.end)}</text>
          </g>
        );
      })}
      {annotations.filter((annotation) => annotation.kind === 'label' && annotation.text && annotation.rowKey).map((annotation, index) => {
        const point = points.find((candidate) => candidate.name === annotation.rowKey);
        if (!point) return null;
        const side = annotation.side ?? 'end';
        const value = annotation.valueKey === valueKeys[0] || side === 'start' ? point.start : point.end;
        return (
          <text
            key={`slope-annotation-${index}`}
            x={side === 'start' ? leftX + 10 : rightX - 10}
            y={yFor(value) - 10}
            textAnchor={side === 'start' ? 'start' : 'end'}
            fill={annotation.color ?? 'var(--rust)'}
            className="assistant-chart-slope-annotation"
          >
            {annotation.text}
          </text>
        );
      })}
    </svg>
  );
}

function ChartView({ block }: { block: ContentBlock }) {
  const reducedMotion = usePrefersReducedMotion();
  const chartType = typeof block.chartType === 'string' ? block.chartType : '';
  const columns = Array.isArray(block.columns) ? block.columns.filter((column): column is string => typeof column === 'string') : [];
  const rows = Array.isArray(block.rows) ? block.rows.filter(isRecord) : [];
  const title = typeof block.title === 'string' ? block.title : undefined;
  const options = isRecord(block.options) ? block.options : {};
  const nameKey = typeof block.nameKey === 'string' ? block.nameKey : columns[0] ?? '';
  const valueKeys = Array.isArray(block.valueKeys)
    ? block.valueKeys.filter((key): key is string => typeof key === 'string')
    : columns.filter((column) => column !== nameKey);
  const series = Array.isArray(block.series)
    ? block.series.filter(isRecord).map((item) => ({
      key: typeof item.key === 'string' ? item.key : '',
      type: typeof item.type === 'string' ? item.type : undefined,
      name: typeof item.name === 'string' ? item.name : undefined
    }))
    : [];
  const annotations = (Array.isArray(block.annotations) ? block.annotations.filter(isRecord) : []) as unknown as ChartAnnotation[];
  const stacked = options.stacked === true;
  const donut = options.donut === true;
  const layout = options.layout === 'horizontal' ? 'horizontal' : 'vertical';
  const showLegend = options.showLegend === true || (options.showLegend !== false && valueKeys.length > 1);
  const showGrid = options.showGrid === true;
  const showValueLabels = options.showValueLabels === true;
  const animationProps = {
    isAnimationActive: !reducedMotion,
    animationDuration: 480,
    animationEasing: 'ease-out' as const
  };

  if (!chartType || columns.length === 0 || rows.length === 0 || !columns.includes(nameKey) || valueKeys.length === 0
    || (chartType === 'scatter' && valueKeys.length < 2)
    || (chartType === 'slope' && valueKeys.length !== 2)) {
    return <p className="assistant-chart-error">This visualization could not be rendered.</p>;
  }

  const axisTick = { fill: 'var(--ink-muted)', fontFamily: 'var(--font-sans)', fontSize: 11 };
  const gridStroke = 'var(--border)';
  const tooltip = <RechartsTooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border-strong)', strokeDasharray: '3 3' }} />;
  const legend = showLegend ? <Legend wrapperStyle={{ color: 'var(--ink-secondary)', fontFamily: 'var(--font-sans)', fontSize: '11px' }} /> : null;

  function renderCartesianChart(ChartComponent: any, seriesRenderer: (key: string, index: number) => ReactNode, extraProps?: Record<string, unknown>) {
    const horizontal = layout === 'horizontal';
    return (
      <ChartComponent data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }} {...extraProps}>
        {showGrid && <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={!horizontal} />}
        {!horizontal && <XAxis dataKey={nameKey} tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} />}
        {horizontal && <YAxis dataKey={nameKey} type="category" tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} width={92} />}
        {!horizontal && <YAxis tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} />}
        {horizontal && <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} />}
        {renderAnnotations(annotations)}
        {tooltip}
        {legend}
        {valueKeys.map(seriesRenderer)}
      </ChartComponent>
    );
  }

  function renderChart(): ReactNode {
    switch (chartType) {
      case 'bar':
        return renderCartesianChart(BarChart, (key, index) => (
          <Bar {...animationProps} key={key} dataKey={key} name={series.find((item) => item.key === key)?.name ?? key} fill={CHART_COLORS[index % CHART_COLORS.length]} radius={[3, 3, 0, 0]} stackId={stacked ? 'stack' : undefined}>
            {showValueLabels && <LabelList dataKey={key} position={layout === 'horizontal' ? 'right' : 'top'} formatter={(value: unknown) => formatChartValue(value)} />}
          </Bar>
        ), { layout: layout === 'horizontal' ? 'vertical' : undefined, barCategoryGap: '22%' });
      case 'line':
        return renderCartesianChart(LineChart, (key, index) => (
          <Line {...animationProps} key={key} type="monotone" dataKey={key} name={series.find((item) => item.key === key)?.name ?? key} stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={2} dot={{ fill: CHART_COLORS[index % CHART_COLORS.length], r: 3 }}>
            {showValueLabels && <LabelList dataKey={key} position="top" formatter={(value: unknown) => formatChartValue(value)} />}
          </Line>
        ));
      case 'area':
        return renderCartesianChart(AreaChart, (key, index) => (
          <Area {...animationProps} key={key} type="monotone" dataKey={key} name={series.find((item) => item.key === key)?.name ?? key} fill={CHART_COLORS[index % CHART_COLORS.length]} stroke={CHART_COLORS[index % CHART_COLORS.length]} fillOpacity={0.16} stackId={stacked ? 'stack' : undefined}>
            {showValueLabels && <LabelList dataKey={key} position="top" formatter={(value: unknown) => formatChartValue(value)} />}
          </Area>
        ));
      case 'composed':
        return renderCartesianChart(ComposedChart, (key, index) => {
          const seriesType = series.find((item) => item.key === key)?.type ?? 'bar';
          const name = series.find((item) => item.key === key)?.name ?? key;
          if (seriesType === 'line') return <Line {...animationProps} key={key} type="monotone" dataKey={key} name={name} stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={2}>{showValueLabels && <LabelList dataKey={key} position="top" formatter={(value: unknown) => formatChartValue(value)} />}</Line>;
          if (seriesType === 'area') return <Area {...animationProps} key={key} type="monotone" dataKey={key} name={name} fill={CHART_COLORS[index % CHART_COLORS.length]} stroke={CHART_COLORS[index % CHART_COLORS.length]} fillOpacity={0.16}>{showValueLabels && <LabelList dataKey={key} position="top" formatter={(value: unknown) => formatChartValue(value)} />}</Area>;
          return <Bar {...animationProps} key={key} dataKey={key} name={name} fill={CHART_COLORS[index % CHART_COLORS.length]} radius={[3, 3, 0, 0]}>{showValueLabels && <LabelList dataKey={key} position={layout === 'horizontal' ? 'right' : 'top'} formatter={(value: unknown) => formatChartValue(value)} />}</Bar>;
        });
      case 'scatter':
        return (
          <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            {showGrid && <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />}
            <XAxis type="number" dataKey={valueKeys[0]} name={valueKeys[0]} tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} />
            <YAxis type="number" dataKey={valueKeys[1]} name={valueKeys[1]} tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} />
            {renderAnnotations(annotations)}
            {tooltip}
            {legend}
            <Scatter {...animationProps} data={rows} dataKey={valueKeys[1]} fill={CHART_COLORS[0]} name={valueKeys[1]}>
              {showValueLabels && <LabelList dataKey={valueKeys[1]} position="top" formatter={(value: unknown) => formatChartValue(value)} />}
            </Scatter>
          </ScatterChart>
        );
      case 'slope':
        return <SlopeChart title={title} rows={rows} nameKey={nameKey} valueKeys={valueKeys} options={options} annotations={annotations} />;
      case 'pie':
        return (
          <PieChart>
            <Pie {...animationProps} data={rows} dataKey={valueKeys[0]} nameKey={nameKey} cx="50%" cy="50%" innerRadius={donut ? 58 : 0} outerRadius={88} paddingAngle={1} label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ''} ${percent != null ? (percent * 100).toFixed(0) : ''}%`} labelLine={{ stroke: 'var(--border-strong)' }}>
              {rows.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
            </Pie>
            <RechartsTooltip content={<ChartTooltip />} />
            {legend}
          </PieChart>
        );
      case 'radialBar':
        return (
          <RadialBarChart data={rows} innerRadius={donut ? 30 : 0} outerRadius={112} startAngle={180} endAngle={0}>
            <RadialBar {...animationProps} dataKey={valueKeys[0]} name={valueKeys[0]} label={{ fill: 'var(--ink-secondary)', fontSize: 11, position: 'insideStart' }} background={{ fill: 'var(--surface-soft)' }}>
              {rows.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
            </RadialBar>
            <RechartsTooltip content={<ChartTooltip />} />
            {showLegend && <Legend wrapperStyle={{ color: 'var(--ink-secondary)', fontFamily: 'var(--font-sans)', fontSize: '11px' }} iconSize={10} />}
          </RadialBarChart>
        );
      case 'radar':
        return (
          <RadarChart data={rows} margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
            {showGrid && <PolarGrid stroke={gridStroke} />}
            <PolarAngleAxis dataKey={nameKey} tick={axisTick} />
            <PolarRadiusAxis tick={axisTick} />
            {tooltip}
            {legend}
            {valueKeys.map((key, index) => <Radar {...animationProps} key={key} dataKey={key} name={key} stroke={CHART_COLORS[index % CHART_COLORS.length]} fill={CHART_COLORS[index % CHART_COLORS.length]} fillOpacity={0.16} />)}
          </RadarChart>
        );
      case 'funnel':
        return (
          <FunnelChart margin={{ top: 8, right: 12, left: 12, bottom: 8 }}>
            <RechartsTooltip content={<ChartTooltip />} />
            <Funnel {...animationProps} dataKey={valueKeys[0]} nameKey={nameKey} data={rows}>
              {rows.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
            </Funnel>
          </FunnelChart>
        );
      case 'treemap':
        return <Treemap data={rows} dataKey={valueKeys[0]} nameKey={nameKey} aspectRatio={4 / 3} stroke="var(--surface)" fill={CHART_COLORS[0]} />;
      case 'sunburst':
        return <SunburstChart data={rows as never} dataKey={valueKeys[0]} nameKey={nameKey} />;
      default:
        return <p className="assistant-chart-error">Unsupported chart type: {chartType}</p>;
    }
  }

  return (
    <figure className="assistant-chart" aria-label={title ? `Chart: ${title}` : `${chartType} chart`} data-chart-type={chartType}>
      {title && <figcaption className="assistant-chart-title">{title}</figcaption>}
      <div className="assistant-chart-plot" style={{ height: CHART_HEIGHT }}>
        {chartType === 'slope' ? renderChart() : (
          <ResponsiveContainer width="100%" height="100%">
            {renderChart()}
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}

export const ChartViewMemo = memo(ChartView);
