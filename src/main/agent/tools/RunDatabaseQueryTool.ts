import type { Tool } from '../types.js';

export const runDatabaseQueryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Execute a read-only database query against the connected database. Use this whenever you need to retrieve data.',
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
      const result = await context.connector.executeQuery(query);
      const elapsedMs = Date.now() - startTime;
      const preview = result.rows.slice(0, 10);
      return {
        ok: true,
        summary: `Query returned ${result.rowCount} row(s) in ${elapsedMs}ms`,
        data: {
          columns: result.columns.map((c: string) => c),
          rowCount: result.rowCount,
          elapsedMs,
          preview,
          totalRows: result.rowCount,
          hasMore: result.rows.length > 10
        }
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
