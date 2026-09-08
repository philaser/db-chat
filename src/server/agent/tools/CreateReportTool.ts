import type { AllChartType, ChartAnnotation, ChartOptions, ChartSeries } from '../../../shared/chart.js';
import type { Tool, ToolContext } from '../types.js';
import { createVisualizeDataTool } from './VisualizeDataTool.js';

type ReportInputBlock = Record<string, unknown> & { type?: string };

export function createReportTool(): Tool {
  const chartTool = createVisualizeDataTool({ requireResultReference: true });
  return {
    definition: {
      type: 'function',
      function: {
        name: 'create_report',
        description: 'Create validated rich report blocks. KPI values, tables, and charts are hydrated server-side from owned result IDs; never supply their rows or values. To total a complete breakdown without another query, use aggregation "sum" with the exact numeric column produced for the same metric and filters; labels do not establish metric meaning.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            finalize: { type: 'boolean', description: 'Set true only when this report fully answers the request. Include the takeaway, metric definitions, and material limitations in text/takeaway blocks. A successful final report ends the turn without another model response; omit or use false for an intermediate report.' },
            blocks: {
              description: 'Report blocks. Each kpi requires resultId and normally column. A scalar KPI may omit column only for a one-column result; rowIndex may be omitted only for a one-row result. To total every row of a complete saved breakdown, provide aggregation "sum" and an explicit column, without rowIndex. Each table requires resultId. Each chart requires resultId and chartType.',
              type: 'array', minItems: 1, maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['takeaway', 'text', 'list', 'kpi', 'table', 'chart'] },
                  text: { type: 'string' },
                  items: { type: 'array', items: { type: 'string' }, maxItems: 12 },
                  label: { type: 'string' },
                  resultId: { type: 'string', description: 'Exact owned result ID returned by run_database_query or get_result.' },
                  column: { type: 'string', description: 'For a KPI, the exact result column containing its value. May be omitted only when the result has exactly one column.' },
                  rowIndex: { type: 'integer', minimum: 0, description: 'For a scalar KPI, the zero-based result row containing its value. May be omitted only for a one-row result.' },
                  aggregation: { type: 'string', enum: ['sum'], description: 'For a KPI, sum the explicit numeric column across every row of a complete owned result. Cannot be combined with rowIndex. NULL values are ignored.' },
                  unit: { type: 'string' },
                  columns: { type: 'array', items: { type: 'string' }, maxItems: 20 },
                  limit: { type: 'integer', minimum: 1, maximum: 50 },
                  chartType: { type: 'string' },
                  title: { type: 'string' },
                  nameKey: { type: 'string' },
                  valueKeys: { type: 'array', items: { type: 'string' } },
                  series: { type: 'array', items: { type: 'object' } },
                  options: { type: 'object' },
                  annotations: { type: 'array', items: { type: 'object' } }
                },
                required: ['type'], additionalProperties: false
              }
            }
          },
          required: ['title', 'blocks'], additionalProperties: false
        }
      }
    },
    async execute(input, context) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const requested = Array.isArray(input.blocks) ? input.blocks as ReportInputBlock[] : [];
      if (!title || title.length > 200 || requested.length === 0 || requested.length > 20) return invalid('Provide a report title and 1 to 20 blocks.');
      if (input.finalize === true && !requested.some((block) => (block.type === 'text' || block.type === 'takeaway') && typeof block.text === 'string' && block.text.trim())) return invalid('A final report needs a text or takeaway block explaining the finding, definitions, and material limitations.');
      const blocks: Record<string, unknown>[] = [{ type: 'heading', level: 2, text: title }];
      let dataBlocks = 0;
      for (const block of requested) {
        if (block.type === 'takeaway' || block.type === 'text') {
          const text = typeof block.text === 'string' ? block.text.trim() : '';
          if (!text) return invalid(`${block.type} requires text.`);
          if (block.type === 'takeaway') blocks.push({ type: 'heading', level: 3, text: 'Takeaway' });
          blocks.push({ type: 'text', content: text });
          continue;
        }
        if (block.type === 'list') {
          const items = Array.isArray(block.items) ? block.items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
          if (items.length === 0 || items.length > 12) return invalid('A report list requires 1 to 12 text items.');
          blocks.push({ type: 'list', items, ordered: false });
          continue;
        }
        const resultId = typeof block.resultId === 'string' ? block.resultId : '';
        const artifact = context.resolveArtifact?.(resultId);
        if (!artifact) return unauthorized(resultId);
        dataBlocks++;
        if (block.type === 'kpi') {
          const aggregation = block.aggregation === 'sum' ? 'sum' : undefined;
          if (block.aggregation !== undefined && !aggregation) return invalid('KPI aggregation must be "sum".');
          if (aggregation && block.rowIndex !== undefined) return invalid('KPI aggregation cannot be combined with rowIndex.');
          const requestedColumn = typeof block.column === 'string' ? block.column : '';
          if (aggregation && !requestedColumn) return invalid(`A summed KPI requires an explicit column in ${resultId}. Available columns: ${artifact.result.columns.join(', ') || '(none)'}.`);
          const column = requestedColumn || (artifact.result.columns.length === 1 ? artifact.result.columns[0] : '');
          if (aggregation) {
            if (!artifact.result.columns.includes(column)) return invalid(`Column "${column}" is not in ${resultId}. Available columns: ${artifact.result.columns.join(', ') || '(none)'}.`);
            if (artifact.result.truncated || artifact.result.rowCount !== artifact.result.rows.length) return invalid('A summed KPI requires a complete saved result; truncated or partial evidence cannot establish the total. Run a complete grouped result or a database aggregate.');
            const sum = sumDecimalColumn(artifact.result.rows, column);
            if (!sum.ok) return invalid(sum.error);
            blocks.push({ type: 'kpi', label: typeof block.label === 'string' && block.label.trim() ? block.label.trim() : column, value: sum.value, unit: typeof block.unit === 'string' ? block.unit : undefined, resultId, column, aggregation, source: artifact.source, capturedAt: artifact.capturedAt });
            continue;
          }
          if (block.rowIndex === undefined && artifact.result.rows.length > 1) return invalid(`KPI rowIndex is required when ${resultId} has multiple rows. Use aggregation "sum" with an explicit column only when the complete breakdown should be totaled.`);
          if (block.rowIndex !== undefined && !Number.isInteger(block.rowIndex)) return invalid('KPI rowIndex must be an integer.');
          const rowIndex = Number.isInteger(block.rowIndex) ? Number(block.rowIndex) : 0;
          if (!artifact.result.columns.includes(column) || rowIndex < 0 || rowIndex >= artifact.result.rows.length) {
            return invalid(`KPI requires an existing column and rowIndex in ${resultId}. Available columns: ${artifact.result.columns.join(', ') || '(none)'}. rowIndex defaults to 0.`);
          }
          const value = artifact.result.rows[rowIndex][column];
          if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return invalid('KPI number must be finite and use a safe integer representation. Return exact high-precision values as decimal strings.');
          if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) return invalid('KPI value must be a scalar or null.');
          blocks.push({ type: 'kpi', label: typeof block.label === 'string' && block.label.trim() ? block.label.trim() : column, value, unit: typeof block.unit === 'string' ? block.unit : undefined, resultId, source: artifact.source, capturedAt: artifact.capturedAt });
          continue;
        }
        if (block.type === 'table') {
          const columns = Array.isArray(block.columns) ? block.columns.filter((column): column is string => typeof column === 'string') : artifact.result.columns;
          const unknown = columns.find((column) => !artifact.result.columns.includes(column));
          if (columns.length === 0 || unknown) return invalid(unknown ? `Column "${unknown}" is not in ${resultId}.` : 'A report table needs columns.');
          const limit = Number.isInteger(block.limit) ? Math.min(50, Math.max(1, Number(block.limit))) : Math.min(15, artifact.result.rows.length);
          blocks.push({ type: 'table', resultId, source: artifact.source, capturedAt: artifact.capturedAt, columns, rows: artifact.result.rows.slice(0, limit).map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))), coverage: coverage(artifact.result.rows.length, artifact.result.rowCount, artifact.result.truncated, limit) });
          continue;
        }
        if (block.type === 'chart') {
          const chartResult = await chartTool.execute({
            resultId,
            chartType: block.chartType as AllChartType,
            title: block.title,
            nameKey: block.nameKey,
            valueKeys: block.valueKeys,
            series: block.series as ChartSeries[] | undefined,
            options: block.options as ChartOptions | undefined,
            annotations: block.annotations as ChartAnnotation[] | undefined,
            unit: block.unit
          }, context as ToolContext);
          if (!chartResult.ok || !chartResult.data) return chartResult;
          blocks.push({ type: 'chart', ...chartResult.data });
          continue;
        }
        return invalid(`Unsupported report block type: ${String(block.type)}`);
      }
      if (dataBlocks === 0) return invalid('A report must include at least one KPI, table, or chart backed by a resultId.');
      const resultIds = [...new Set(requested.map((block) => block.resultId).filter((id): id is string => typeof id === 'string'))];
      return { ok: true, summary: `Created report "${title}" with ${blocks.length} validated block(s).`, data: { title, blocks, resultIds, finalize: input.finalize === true, sources: resultIds.map((id) => context.resolveArtifact?.(id)?.source).filter(Boolean) } };
    }
  };
}

type ParsedDecimal = { coefficient: bigint; scale: number; fromNumber: boolean };

function sumDecimalColumn(rows: Record<string, unknown>[], column: string): { ok: true; value: string | number } | { ok: false; error: string } {
  if (rows.length === 0) return { ok: false, error: 'A summed KPI requires at least one saved result row.' };
  const values: ParsedDecimal[] = [];
  for (const row of rows) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    const parsed = parseDecimal(value);
    if (!parsed) return { ok: false, error: `KPI sum requires finite decimal numbers in column "${column}"; booleans, non-numeric text, unsafe numeric integers, and excessive precision are rejected.` };
    values.push(parsed);
  }
  if (values.length === 0) return { ok: false, error: `KPI sum found no non-NULL numeric values in column "${column}".` };
  const scale = Math.max(...values.map((value) => value.scale));
  const coefficient = values.reduce((total, value) => total + value.coefficient * powerOfTen(scale - value.scale), 0n);
  const rendered = renderDecimal(coefficient, scale);
  if (values.every((value) => value.fromNumber) && scale === 0 && coefficient <= BigInt(Number.MAX_SAFE_INTEGER) && coefficient >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return { ok: true, value: Number(coefficient) };
  }
  return { ok: true, value: rendered };
}

function parseDecimal(value: unknown): ParsedDecimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (!match[2] && !match[3])) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+(?=\d)/, '') || '0';
  if (digits.length > 1000) return null;
  let scale = (match[3]?.length ?? 0) - exponent;
  let coefficient = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
  if (scale < 0) { coefficient *= powerOfTen(-scale); scale = 0; }
  if (scale > 1000) return null;
  return { coefficient, scale, fromNumber: typeof value === 'number' };
}

function powerOfTen(exponent: number): bigint { return 10n ** BigInt(exponent); }

function renderDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const value = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && coefficient !== 0n ? `-${value}` : value;
}

function coverage(loaded: number, total: number, truncated: boolean | undefined, returned: number) {
  return { returnedRowCount: Math.min(loaded, returned), loadedRowCount: loaded, totalRowCount: truncated ? null : total, truncated: truncated ?? false };
}

function invalid(summary: string) {
  return { ok: false as const, summary, error: summary, data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true } };
}

function unauthorized(resultId: string) {
  return { ok: false as const, summary: 'Result not found in this chat.', error: `Unknown or unauthorized resultId: ${resultId}`, data: { errorCode: 'RESULT_NOT_FOUND', retryable: false } };
}
