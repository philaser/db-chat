import type { Tool } from '../types';

export const sampleDataTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'sample_data',
      description: 'Get a small sample of rows from a table to understand its data.',
      parameters: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'The name of the table to sample from.'
          },
          limit: {
            type: 'number',
            description: 'Number of rows to return (default: 5, max: 25).'
          }
        },
        required: ['tableName'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName, limit = 5 } = input as { tableName: string; limit?: number };
    if (!context.connector) {
      return { ok: false, summary: 'No database connected' };
    }
    const safeLimit = Math.min(Math.max(1, limit), 25);
    try {
      const result = await context.connector.executeQuery(
        `SELECT * FROM "${tableName}" LIMIT ${safeLimit}`
      );
      return {
        ok: true,
        summary: `${result.rowCount} row(s) from "${tableName}"`,
        data: {
          columns: result.columns.map((c) => c.name),
          rows: result.rows.slice(0, safeLimit),
          rowCount: result.rowCount
        }
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Failed to sample "${tableName}"`,
        error: (error as Error).message
      };
    }
  }
};
