import type { Tool } from '../types.js';

export type AllChartType =
  | 'bar' | 'line' | 'area' | 'pie' | 'scatter'
  | 'radar' | 'radialBar' | 'composed' | 'funnel' | 'treemap' | 'sunburst';

export interface ChartSeries {
  key: string;
  type?: 'bar' | 'line' | 'area';
  name?: string;
}

export interface ChartOptions {
  layout?: 'vertical' | 'horizontal';
  stacked?: boolean;
  donut?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
}

export interface ChartSpec {
  chartType: AllChartType;
  title?: string;
  columns: string[];
  rows: Record<string, unknown>[];
  nameKey?: string;
  valueKeys?: string[];
  series?: ChartSeries[];
  options?: ChartOptions;
}

const CHART_TYPES: AllChartType[] = [
  'bar', 'line', 'area', 'pie', 'scatter',
  'radar', 'radialBar', 'composed', 'funnel', 'treemap', 'sunburst'
];

const DEFAULT_COLORS = [
  '#007aff', '#ff9f0a', '#34c759', '#ff3b30', '#bf5af2',
  '#0a84ff', '#ffd60a', '#30d158', '#ff453a', '#64d2ff',
  '#5e5ce6', '#ff375f'
];

function validateSpec(spec: ChartSpec): string | null {
  if (!spec.columns || !Array.isArray(spec.columns) || spec.columns.length === 0) {
    return 'columns must be a non-empty array';
  }
  if (!spec.rows || !Array.isArray(spec.rows) || spec.rows.length === 0) {
    return 'rows must be a non-empty array';
  }
  if (!CHART_TYPES.includes(spec.chartType)) {
    return `Unsupported chart type: ${spec.chartType}. Supported: ${CHART_TYPES.join(', ')}`;
  }

  const nameKey = spec.nameKey ?? spec.columns[0];
  if (!spec.columns.includes(nameKey)) {
    return `nameKey "${nameKey}" not found in columns`;
  }

  // Determine value keys
  let valueKeys = spec.valueKeys;
  if (!valueKeys || valueKeys.length === 0) {
    valueKeys = spec.columns.filter((c) => c !== nameKey);
  }
  for (const vk of valueKeys) {
    if (!spec.columns.includes(vk)) {
      return `valueKey "${vk}" not found in columns`;
    }
  }

  // Chart-specific validation
  switch (spec.chartType) {
    case 'pie':
    case 'radialBar':
    case 'funnel':
      if (valueKeys.length !== 1) {
        return `${spec.chartType} chart requires exactly one value column`;
      }
      break;
    case 'treemap':
    case 'sunburst':
      if (spec.options?.donut) {
        // donut doesn't apply to these
      }
      break;
  }

  // Verify rows have the required keys
  for (let i = 0; i < spec.rows.length; i++) {
    const row = spec.rows[i];
    if (!row || typeof row !== 'object') {
      return `Row ${i} is not a valid object`;
    }
    if (!(nameKey in row)) {
      return `Row ${i} missing nameKey "${nameKey}"`;
    }
    for (const vk of valueKeys) {
      if (!(vk in row)) {
        return `Row ${i} missing valueKey "${vk}"`;
      }
    }
  }

  return null;
}

export const visualizeDataTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'visualize_data',
      description: 'Generate a chart visualization from data. Supports: bar, line, area, pie, scatter, radar, radialBar, composed, funnel, treemap, sunburst. Pass data in the same column/rows format as query results. The tool validates and returns a chart spec that you present in a ```chart code block.',
      parameters: {
        type: 'object',
        properties: {
          chartType: {
            type: 'string',
            description: 'Chart type. bar=vertical bars, line=connected points, area=filled line, pie=circular segments, scatter=xy points, radar=spider web, radialBar=circular bars, composed=bar+line mix, funnel=progressive stages, treemap=nested rectangles, sunburst=ring hierarchy.',
            enum: CHART_TYPES
          },
          title: {
            type: 'string',
            description: 'Chart title displayed above the visualization.'
          },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column names from your query results.'
          },
          rows: {
            type: 'array',
            items: { type: 'object' },
            description: 'Data rows from your query results, each as a {column: value} object.'
          },
          nameKey: {
            type: 'string',
            description: 'Column to use for labels/categories. Defaults to the first column.'
          },
          valueKeys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column(s) to use for values. Defaults to all numeric columns after nameKey.'
          },
          series: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                type: { type: 'string', enum: ['bar', 'line', 'area'] },
                name: { type: 'string' }
              },
              required: ['key']
            },
            description: 'Series configuration for multi-series charts or composed charts. Each entry maps a valueKey to optional type/name overrides.'
          },
          options: {
            type: 'object',
            properties: {
              layout: { type: 'string', enum: ['vertical', 'horizontal'], description: 'Bar chart orientation (default vertical).' },
              stacked: { type: 'boolean', description: 'Stack bars/area series (default false).' },
              donut: { type: 'boolean', description: 'Render pie/radialBar as a donut (default false).' },
              showLegend: { type: 'boolean', description: 'Show legend (default true for multi-series).' },
              showGrid: { type: 'boolean', description: 'Show grid lines (default true for Cartesian charts).' }
            },
            description: 'Optional chart configuration.'
          }
        },
        required: ['chartType', 'columns', 'rows'],
        additionalProperties: false
      }
    }
  },

  async execute(input, _context) {
    const { chartType, title, columns, rows, nameKey, valueKeys, series, options } = input as Record<string, unknown>;

    const spec: ChartSpec = {
      chartType: chartType as AllChartType,
      title: title as string | undefined,
      columns: columns as string[],
      rows: rows as Record<string, unknown>[],
      nameKey: nameKey as string | undefined,
      valueKeys: valueKeys as string[] | undefined,
      options: options as ChartOptions | undefined
    };

    if (series) {
      spec.series = (series as ChartSeries[]).map((s) => ({
        key: s.key,
        type: s.type,
        name: s.name
      }));
    }

    const error = validateSpec(spec);
    if (error) {
      return { ok: false, summary: error, error };
    }

    // Fill defaults
    const resolvedNameKey = spec.nameKey ?? spec.columns[0];
    const resolvedValueKeys = spec.valueKeys ?? spec.columns.filter((c) => c !== resolvedNameKey);

    return {
      ok: true,
      summary: `Generated ${chartType} chart: "${title ?? 'untitled'}" (${(rows as unknown[]).length} rows, ${resolvedValueKeys.length} series)`,
      data: {
        chartType: spec.chartType,
        title: spec.title,
        columns: spec.columns,
        rows: spec.rows,
        nameKey: resolvedNameKey,
        valueKeys: resolvedValueKeys,
        series: spec.series,
        options: spec.options,
        colors: DEFAULT_COLORS.slice(0, Math.max(resolvedValueKeys.length, 1))
      }
    };
  }
};