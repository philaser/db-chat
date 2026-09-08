import type { ColumnInfo, DatabaseSchema, TableInfo } from '../../../shared/types.js';
import type { Tool } from '../types.js';

const MAX_SAMPLE_ROWS = 25;
const MAX_PROFILE_COLUMNS = 8;
const DOCUMENT_PROFILE_ROWS = 100;
const DEFAULT_EXCLUDED_FIELD = /(?:password|passwd|secret|token|api.?key|credential|private.?key|session|cookie)/i;

export const sampleDataTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'sample_data',
      description: 'Inspect selected columns. Prefer bounded aggregate profile mode, which returns counts/nulls/distinct/range without raw rows. Use rows mode only when actual example values are necessary.',
      parameters: {
        type: 'object',
        properties: {
          tableName: { type: 'string', description: 'Exact table or qualified table name from the schema.' },
          columns: { type: 'array', items: { type: 'string' }, maxItems: MAX_PROFILE_COLUMNS, description: 'Selected columns. Profile mode requires at most 8; rows mode returns only these fields.' },
          excludeColumns: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Additional fields to exclude. Credential-like fields are excluded by default.' },
          mode: { type: 'string', enum: ['profile', 'rows'], description: 'Defaults to profile.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SAMPLE_ROWS, description: `Rows mode limit (default 5, max ${MAX_SAMPLE_ROWS}).` }
        },
        required: ['tableName'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName, mode = 'profile', limit = 5 } = input as { tableName: string; mode?: 'profile' | 'rows'; limit?: number };
    if (!context.connector) return { ok: false, summary: 'No database connected', error: 'No active database connection' };
    if (typeof tableName !== 'string' || !tableName.trim() || !['profile', 'rows'].includes(mode) || !Number.isFinite(limit)) return invalid('Choose a schema table, profile or rows mode, and a finite limit.');
    const schema = context.schema ?? await context.connector.introspect();
    const matches = findTables(schema, tableName);
    if (matches.length > 1) return { ok: false, summary: `Table name "${tableName}" is ambiguous. Use a qualified name.`, error: 'Ambiguous table name', data: { errorCode: 'AMBIGUOUS_TABLE', choices: matches.map((table) => table.qualifiedName ?? table.name), retryable: true } };
    const table = matches[0];
    if (!table) return invalid('Choose an exact table or qualified table name from the connected schema.');
    const requested = Array.isArray(input.columns) ? input.columns.filter((column): column is string => typeof column === 'string') : table.columns.map((column) => column.name);
    const explicitExclusions = new Set(Array.isArray(input.excludeColumns) ? input.excludeColumns.filter((column): column is string => typeof column === 'string') : []);
    const excludedColumns = table.columns.map((column) => column.name).filter((column) => explicitExclusions.has(column) || DEFAULT_EXCLUDED_FIELD.test(column));
    const columns = [...new Set(requested)].filter((column) => !excludedColumns.includes(column)).slice(0, MAX_PROFILE_COLUMNS);
    if (table.columns.length > 0 && columns.length === 0) return invalid('Every selected column is excluded by the profiling policy. Choose non-sensitive fields.');
    const unknown = columns.find((column) => !table.columns.some((candidate) => candidate.name === column));
    if (unknown) return invalid(`Column "${unknown}" is not in ${table.qualifiedName ?? table.name}.`);
    const safeLimit = Math.floor(Math.min(Math.max(1, limit), MAX_SAMPLE_ROWS));

    try {
      if (mode === 'profile' && ['sqlite', 'mysql', 'postgres'].includes(schema.kind)) {
        const query = sqlProfileQuery(schema, table, columns);
        const result = await context.connector.executeQuery(query, { signal: context.signal });
        return {
          ok: true,
          summary: `Profiled ${columns.length} column(s) in "${table.qualifiedName ?? table.name}" without returning raw rows.`,
          data: { mode: 'profile', tableName: table.qualifiedName ?? table.name, columns, excludedColumns, profileFields: profileFieldMap(columns), profile: result.rows[0] ?? {}, coverage: 'full table aggregate', rawRowsReturned: 0 }
        };
      }

      const sampleLimit = mode === 'profile' ? DOCUMENT_PROFILE_ROWS : safeLimit;
      const query = sampleQuery(schema, table, columns, sampleLimit);
      const result = await context.connector.executeQuery(query, { signal: context.signal });
      const resolvedColumns = columns.length > 0 ? columns : result.columns;
      const rows = result.rows.slice(0, sampleLimit).map((row) => Object.fromEntries(resolvedColumns.map((column) => [column, row[column]])));
      if (mode === 'profile') {
        return {
          ok: true,
          summary: `Profiled ${columns.length} column(s) from a bounded ${rows.length}-row document sample.`,
          data: { mode: 'profile', tableName: table.qualifiedName ?? table.name, columns: resolvedColumns, excludedColumns, profile: profileRows(rows, resolvedColumns), coverage: `sample of ${rows.length} row(s), maximum ${DOCUMENT_PROFILE_ROWS}`, partial: true, rawRowsReturned: 0 }
        };
      }
      return { ok: true, summary: `${rows.length} sample row(s) from "${table.qualifiedName ?? table.name}"`, data: { mode: 'rows', tableName: table.qualifiedName ?? table.name, columns: resolvedColumns, excludedColumns, rows, returnedRowCount: rows.length, coverage: `first ${rows.length} row(s), maximum ${safeLimit}`, partial: true } };
    } catch (error) {
      return { ok: false, summary: `Failed to inspect "${table.qualifiedName ?? table.name}"`, error: (error as Error).message, data: { errorCode: 'PROFILE_FAILED', retryable: true } };
    }
  }
};

function findTables(schema: DatabaseSchema, tableName: string): TableInfo[] {
  const target = tableName.replace(/["`]/g, '').toLowerCase();
  const exact = schema.tables.filter((table) => table.qualifiedName === tableName);
  const qualified = exact.length > 0 ? exact : schema.tables.filter((table) => table.qualifiedName?.replace(/["`]/g, '').toLowerCase() === target);
  return qualified.length > 0 ? qualified : schema.tables.filter((table) => table.name.toLowerCase() === target);
}

function quoteIdentifier(kind: DatabaseSchema['kind'], value: string): string {
  return kind === 'mysql' ? '`' + value.replace(/`/g, '``') + '`' : '"' + value.replace(/"/g, '""') + '"';
}

function qualifiedIdentifier(schema: DatabaseSchema, table: TableInfo): string {
  return table.schema ? `${quoteIdentifier(schema.kind, table.schema)}.${quoteIdentifier(schema.kind, table.name)}` : quoteIdentifier(schema.kind, table.name);
}

function sqlProfileQuery(schema: DatabaseSchema, table: TableInfo, columns: string[]): string {
  const expressions = ['COUNT(*) AS "profile_row_count"'];
  for (const [index, columnName] of columns.entries()) {
    const column = table.columns.find((candidate) => candidate.name === columnName) as ColumnInfo;
    const quoted = quoteIdentifier(schema.kind, columnName);
    const alias = `c${index + 1}`;
    expressions.push(`COUNT(${quoted}) AS "${alias}_non_null_count"`, `COUNT(*) - COUNT(${quoted}) AS "${alias}_null_count"`, `COUNT(DISTINCT ${quoted}) AS "${alias}_distinct_count"`);
    if (/(json|blob|binary|array|object)/i.test(column.type)) expressions.pop();
    else expressions.push(`MIN(${quoted}) AS "${alias}_min"`, `MAX(${quoted}) AS "${alias}_max"`);
  }
  return `SELECT ${expressions.join(', ')} FROM ${qualifiedIdentifier(schema, table)}`;
}

function profileFieldMap(columns: string[]): Record<string, string> {
  return Object.fromEntries(columns.map((column, index) => [`c${index + 1}`, column]));
}

function sampleQuery(schema: DatabaseSchema, table: TableInfo, columns: string[], limit: number): string {
  if (schema.kind === 'mongodb') return JSON.stringify({ collection: table.name, method: 'find', body: { ...(columns.length ? { options: { projection: Object.fromEntries(columns.map((column) => [column, 1])) } } : {}), limit } });
  if (schema.kind === 'elasticsearch') return JSON.stringify({ index: table.name, body: { size: limit, ...(columns.length ? { _source: columns } : {}), query: { match_all: {} } } });
  return `SELECT ${columns.length ? columns.map((column) => quoteIdentifier(schema.kind, column)).join(', ') : '*'} FROM ${qualifiedIdentifier(schema, table)} LIMIT ${limit}`;
}

function profileRows(rows: Record<string, unknown>[], columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column) => {
    const values = rows.map((row) => row[column]);
    const present = values.filter((value) => value !== null && value !== undefined);
    const numeric = present.map(Number).filter(Number.isFinite);
    return [column, {
      sampledRowCount: rows.length,
      nonNullCount: present.length,
      nullCount: rows.length - present.length,
      sampledDistinctCount: new Set(present.map((value) => JSON.stringify(value))).size,
      ...(numeric.length === present.length && numeric.length > 0 ? { min: Math.min(...numeric), max: Math.max(...numeric) } : {})
    }];
  }));
}

function invalid(summary: string) {
  return { ok: false as const, summary, error: summary, data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true } };
}
