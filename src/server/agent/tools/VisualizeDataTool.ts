import type { Tool } from '../types.js';

import type { AllChartType, ChartAnnotation, ChartSeries, ChartOptions, ChartSpec } from '../../../shared/chart.js';
export type { AllChartType, ChartAnnotation, ChartSeries, ChartOptions, ChartSpec } from '../../../shared/chart.js';

const CHART_TYPES: AllChartType[] = [
  'bar', 'line', 'area', 'pie', 'scatter',
  'radar', 'radialBar', 'composed', 'funnel', 'treemap', 'sunburst', 'slope'
];

const DEFAULT_COLORS = [
  '#007aff', '#ff9f0a', '#34c759', '#ff3b30', '#bf5af2',
  '#0a84ff', '#ffd60a', '#30d158', '#ff453a', '#64d2ff',
  '#5e5ce6', '#ff375f'
];

type ValidatedChartSpec = ChartSpec & { resultId?: string; unit?: string; series?: Array<ChartSeries & { unit?: string }> };

function validateSpec(spec: ValidatedChartSpec): string | null {
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
  if (new Set(valueKeys).size !== valueKeys.length) return 'valueKeys must not contain duplicates';
  if (spec.series) {
    const configuredSeries = spec.series as Array<ChartSeries & { unit?: string }>;
    const unknownSeries = configuredSeries.find((entry) => !valueKeys.includes(entry.key));
    if (unknownSeries) return `series key "${unknownSeries.key}" is not a selected valueKey`;
    const units = new Set([spec.unit, ...configuredSeries.map((entry) => entry.unit)].filter((unit): unit is string => Boolean(unit)));
    if (units.size > 1) return 'Mixed-unit series are not supported in one chart. Use separate charts or one common unit.';
  }
  if (spec.unit && (spec.unit.trim().length === 0 || spec.unit.length > 40)) return 'unit must be between 1 and 40 characters';

  // Chart-specific validation
  switch (spec.chartType) {
    case 'pie':
    case 'radialBar':
    case 'funnel':
      if (valueKeys.length !== 1) {
        return `${spec.chartType} chart requires exactly one value column`;
      }
      break;
    case 'scatter':
      if (valueKeys.length < 2) {
        return 'scatter chart requires at least two value columns';
      }
      break;
    case 'slope':
      if (valueKeys.length !== 2) {
        return 'slope chart requires exactly two value columns';
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
      const value = row[vk];
      if (value !== null && value !== undefined && value !== '' && !(typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && Number.isFinite(Number(value)))) {
        return `valueKey "${vk}" contains a non-numeric value at row ${i}`;
      }
      if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim()) && !Number.isSafeInteger(Number(value))) {
        return `valueKey "${vk}" contains an integer outside the safe chart range at row ${i}`;
      }
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
        return `valueKey "${vk}" contains an integer outside the safe chart range at row ${i}`;
      }
    }
  }

  for (const vk of valueKeys) {
    if (!spec.rows.some((row) => {
      const value = row[vk];
      return typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    })) return `valueKey "${vk}" has no finite numeric values`;
  }

  return null;
}

export function createVisualizeDataTool(options: { requireResultReference?: boolean } = {}): Tool {
  return {
  definition: {
    type: 'function',
    function: {
      name: 'visualize_data',
      description: options.requireResultReference
        ? 'Generate a validated chart from a server-owned resultId. Rows are resolved server-side and cannot be supplied by the model.'
        : 'Generate a validated chart. Prefer a server-owned resultId; direct rows remain available for trusted local fixtures.',
      parameters: {
        type: 'object',
        properties: {
          resultId: { type: 'string', description: 'Owned result ID returned by run_database_query or get_result.' },
          chartType: {
            type: 'string',
            description: 'Chart type. bar=vertical bars, line=connected points, area=filled line, pie=circular segments, scatter=xy points, radar=spider web, radialBar=circular bars, composed=bar+line mix, funnel=progressive stages, treemap=nested rectangles, sunburst=ring hierarchy, slope=two-endpoint comparison.',
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
          unit: { type: 'string', description: 'Optional common unit for all value series. Do not infer a unit.' },
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
                name: { type: 'string' },
                unit: { type: 'string' }
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
              showLegend: { type: 'boolean', description: 'Show a legend when direct labels are not sufficient (opt in).' },
              showGrid: { type: 'boolean', description: 'Show grid lines when they help read the comparison (opt in).' },
              showValueLabels: { type: 'boolean', description: 'Show direct values on the marks instead of relying only on a tooltip.' },
              startLabel: { type: 'string', description: 'Left-side label for a slope chart.' },
              endLabel: { type: 'string', description: 'Right-side label for a slope chart.' }
            },
            description: 'Optional chart configuration.'
          },
          annotations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['label', 'point', 'line', 'range'] },
                text: { type: 'string' },
                x: {},
                y: { type: 'number' },
                x1: {},
                y1: { type: 'number' },
                x2: {},
                y2: { type: 'number' },
                color: { type: 'string' },
                position: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'insideTop', 'insideBottom'] },
                rowKey: { type: 'string' },
                valueKey: { type: 'string' },
                side: { type: 'string', enum: ['start', 'end'] }
              },
              required: ['kind'],
              additionalProperties: false
            },
            description: 'Optional editorial labels, reference points, lines, and ranges. Use data coordinates for x/y values; use rowKey/valueKey/side for slope labels.'
          }
        },
        required: options.requireResultReference ? ['chartType', 'resultId'] : ['chartType'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { resultId, chartType, title, nameKey, valueKeys, series, options: chartOptions, annotations, unit } = input as Record<string, unknown>;
    const artifact = typeof resultId === 'string' ? context.resolveArtifact?.(resultId) : undefined;
    if (typeof resultId === 'string' && !artifact) {
      return { ok: false, summary: 'Result not found in this chat.', error: 'Unknown or unauthorized resultId', data: { errorCode: 'RESULT_NOT_FOUND', retryable: false } };
    }
    if (options.requireResultReference && !artifact) {
      return { ok: false, summary: 'A valid owned resultId is required.', error: 'Missing resultId', data: { errorCode: 'RESULT_REFERENCE_REQUIRED', retryable: true } };
    }
    const columns = artifact?.result.columns ?? input.columns;
    const rows = artifact?.result.rows ?? input.rows;

    const spec: ValidatedChartSpec = {
      resultId: artifact?.queryId,
      chartType: chartType as AllChartType,
      title: title as string | undefined,
      columns: columns as string[],
      rows: rows as Record<string, unknown>[],
      nameKey: nameKey as string | undefined,
      valueKeys: valueKeys as string[] | undefined,
      options: chartOptions as ChartOptions | undefined,
      annotations: annotations as ChartAnnotation[] | undefined,
      unit: typeof unit === 'string' ? unit : undefined
    };

    if (series) {
      spec.series = (series as Array<ChartSeries & { unit?: string }>).map((s) => ({
        key: s.key,
        type: s.type,
        name: s.name,
        unit: s.unit
      }));
    }

    const error = validateSpec(spec);
    if (error) {
      return { ok: false, summary: error, error };
    }

    // Fill defaults
    const resolvedNameKey = spec.nameKey ?? spec.columns[0];
    const resolvedValueKeys = spec.valueKeys ?? spec.columns.filter((c) => c !== resolvedNameKey);
    const normalizedRows = spec.rows.map((row) => ({
      ...row,
      ...Object.fromEntries(resolvedValueKeys.map((key) => {
        const value = row[key];
        return [key, typeof value === 'string' && value.trim() !== '' ? Number(value) : value];
      }))
    }));

    return {
      ok: true,
      summary: `Generated ${chartType} chart: "${title ?? 'untitled'}" (${normalizedRows.length} rows, ${resolvedValueKeys.length} series)`,
      data: {
        resultId: artifact?.queryId,
        source: artifact?.source,
        capturedAt: artifact?.capturedAt,
        chartType: spec.chartType,
        title: spec.title,
        columns: spec.columns,
        rows: normalizedRows,
        nameKey: resolvedNameKey,
        valueKeys: resolvedValueKeys,
        series: spec.series,
        options: spec.options,
        annotations: spec.annotations,
        unit: spec.unit,
        coverage: artifact ? {
          returnedRowCount: artifact.result.rows.length,
          totalRowCount: artifact.result.truncated ? null : artifact.result.rowCount,
          truncated: artifact.result.truncated ?? false,
          rowLimit: artifact.result.rowLimit
        } : undefined,
        colors: DEFAULT_COLORS.slice(0, Math.max(resolvedValueKeys.length, 1))
      }
    };
  }
  };
}

export const visualizeDataTool: Tool = createVisualizeDataTool();
