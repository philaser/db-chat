import type { Tool } from '../types.js';

import { classifyQuery } from '../../connectors/QueryValidator.js';

export const runDatabaseQueryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Run one permanently read-only SQL SELECT/WITH query or read-only document/search request. This tool cannot insert, update, delete, create, alter, or repair source data.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The exact SQL query or JSON request string for the database connector.'
          },
          purpose: {
            type: 'string',
            description: 'A brief, user-visible description of what this query does.'
          },
          assumptions: {
            type: 'array', maxItems: 8, items: { type: 'string' },
            description: 'Material analytical assumptions used by this query, such as entity grain, date boundary, or metric definition. Omit when none.'
          },
          verification: {
            type: 'array', maxItems: 8,
            items: {
              type: 'object',
              properties: {
                check: { type: 'string', enum: ['grain', 'join-cardinality', 'distinct-count', 'nulls', 'denominator', 'time-boundary', 'reconciliation'] },
                status: { type: 'string', enum: ['checked', 'not-applicable', 'unresolved'] },
                detail: { type: 'string' }
              },
              required: ['check', 'status', 'detail'], additionalProperties: false
            },
            description: 'Checks this query performs or leaves unresolved. Mark a check checked only when the result supports it.'
          }
        },
        required: ['query', 'purpose'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { query, purpose, assumptions, verification } = input as { query: string; purpose: string; assumptions?: unknown[]; verification?: unknown[] };
    if (!context.connector) {
      return { ok: false, summary: 'No database connected', error: 'No active database connection' };
    }
    if (typeof query !== 'string' || !query.trim() || typeof purpose !== 'string' || !purpose.trim()) {
      return {
        ok: false,
        summary: 'A non-empty read-only query and purpose are required.',
        error: 'Invalid query tool input',
        data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true }
      };
    }
    const queryType = classifyQuery(query);
    if (queryType !== 'read') {
      return {
        ok: false,
        summary: 'Blocked: DB Chat is permanently read-only. Use one explicit read query.',
        error: 'Only read queries are supported',
        data: { errorCode: 'READ_ONLY_POLICY', queryType, retryable: false }
      };
    }
    const startTime = Date.now();
    try {
      const result = await context.connector.executeQuery(query, { signal: context.signal });
      const elapsedMs = Date.now() - startTime;
      const resultId = context.allocateResultId?.() ?? `${context.turnId}-query-1`;
      const analyticalContext = {
        assumptions: Array.isArray(assumptions) ? assumptions.filter((value): value is string => typeof value === 'string').slice(0, 8) : [],
        verification: Array.isArray(verification) ? verification.filter((value) => value && typeof value === 'object').slice(0, 8) : []
      };
      const preview = result.rows.slice(0, 10);
      return {
        ok: true,
        summary: `Query returned ${result.rowCount} row(s) in ${elapsedMs}ms${result.truncated ? ` (truncated at ${result.rowLimit} rows)` : ''}`,
        data: {
          queryType: 'read',
          resultId,
          analyticalContext,
          columns: result.columns.map((c: string) => c),
          returnedRowCount: result.rows.length,
          loadedRowCount: result.rows.length,
          elapsedMs,
          preview,
          totalRowCount: result.truncated ? null : result.rowCount,
          previewRowCount: preview.length,
          hasMore: result.rows.length > 10 || result.truncated === true,
          truncated: result.truncated ?? false,
          rowLimit: result.rowLimit
        },
        artifact: result
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Query failed: ${(error as Error).message}`,
        error: (error as Error).message,
        data: { errorCode: 'QUERY_EXECUTION_FAILED', retryable: true }
      };
    }
  }
};
