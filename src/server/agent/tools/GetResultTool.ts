import type { Tool } from '../types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const getResultTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_result',
      description: 'Retrieve a bounded slice of a server-owned result by resultId. Use this for follow-ups instead of relying on a narrative preview.',
      parameters: {
        type: 'object',
        properties: {
          resultId: { type: 'string', description: 'The exact owned result ID returned by run_database_query.' },
          offset: { type: 'integer', minimum: 0, description: 'Zero-based row offset (default 0).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Rows to retrieve (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
          columns: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Optional result columns to retrieve.' }
        },
        required: ['resultId'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const resultId = typeof input.resultId === 'string' ? input.resultId.trim() : '';
    const offset = Number.isInteger(input.offset) && Number(input.offset) >= 0 ? Number(input.offset) : 0;
    const limit = Number.isInteger(input.limit) ? Math.min(MAX_LIMIT, Math.max(1, Number(input.limit))) : DEFAULT_LIMIT;
    if (!resultId) return invalid('A resultId is required.');
    const artifact = context.resolveArtifact?.(resultId);
    if (!artifact) {
      return { ok: false, summary: 'Result not found in this chat.', error: 'Unknown or unauthorized resultId', data: { errorCode: 'RESULT_NOT_FOUND', retryable: false } };
    }
    const requested = Array.isArray(input.columns) ? input.columns.filter((column): column is string => typeof column === 'string') : artifact.result.columns;
    const unknown = requested.find((column) => !artifact.result.columns.includes(column));
    if (unknown) return invalid(`Column "${unknown}" is not in result ${resultId}.`);
    const rows = artifact.result.rows.slice(offset, offset + limit).map((row) => Object.fromEntries(requested.map((column) => [column, row[column]])));
    const loadedRowCount = artifact.result.rows.length;
    return {
      ok: true,
      summary: `Retrieved ${rows.length} of ${loadedRowCount} loaded row(s) from result ${resultId}.`,
      data: {
        resultId,
        columns: requested,
        rows,
        offset,
        returnedRowCount: rows.length,
        loadedRowCount,
        totalRowCount: artifact.result.truncated ? null : artifact.result.rowCount,
        hasMore: offset + rows.length < loadedRowCount || artifact.result.truncated === true,
        truncated: artifact.result.truncated ?? false,
        rowLimit: artifact.result.rowLimit,
        source: artifact.source,
        capturedAt: artifact.capturedAt
      }
    };
  }
};

function invalid(summary: string) {
  return { ok: false as const, summary, error: summary, data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true } };
}
