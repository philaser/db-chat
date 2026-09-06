import type { Tool } from '../types.js';

import { classifyQuery } from '../../connectors/QueryValidator.js';

export const runDatabaseQueryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Execute a SQL query or database command against the connected database. Supports read queries, write operations (INSERT/UPDATE/DELETE), and DDL statements (CREATE/DROP/ALTER) subject to the current safety level.',
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
          }
        },
        required: ['query', 'purpose'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { query, purpose } = input as { query: string; purpose: string };
    if (!context.connector) {
      return { ok: false, summary: 'No database connected', error: 'No active database connection' };
    }
    const startTime = Date.now();
    try {
      const result = await context.connector.executeQuery(query, { signal: context.signal });
      const elapsedMs = Date.now() - startTime;

      const isDDL = classifyQuery(query) === 'ddl';
      const isWrite = classifyQuery(query) === 'write';

      if (isDDL) {
        return {
          ok: true,
          summary: `DDL statement executed successfully in ${elapsedMs}ms`,
          data: {
            queryType: 'ddl',
            rowCount: result.rowCount,
            elapsedMs,
            columns: result.columns.map((c: string) => c),
            preview: result.rows.slice(0, 10),
            totalRows: result.rowCount
          },
          artifact: result
        };
      }

      if (isWrite) {
        return {
          ok: true,
          summary: `Write query affected ${result.rowCount} row(s) in ${elapsedMs}ms`,
          data: {
            queryType: 'write',
            rowCount: result.rowCount,
            elapsedMs,
            columns: result.columns.map((c: string) => c),
            preview: result.rows.slice(0, 10),
            totalRows: result.rowCount
          },
          artifact: result
        };
      }

      const preview = result.rows.slice(0, 10);
      return {
        ok: true,
        summary: `Query returned ${result.rowCount} row(s) in ${elapsedMs}ms${result.truncated ? ` (truncated at ${result.rowLimit} rows)` : ''}`,
        data: {
          queryType: 'read',
          columns: result.columns.map((c: string) => c),
          rowCount: result.rowCount,
          elapsedMs,
          preview,
          totalRows: result.rowCount,
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
        error: (error as Error).message
      };
    }
  }
};
