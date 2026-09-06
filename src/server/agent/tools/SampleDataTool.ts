import type { Tool } from '../types.js';

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
    if (typeof tableName !== 'string' || !tableName || !Number.isFinite(limit)) {
      return { ok: false, summary: 'A table name and a finite sample limit are required.' };
    }
    const safeLimit = Math.floor(Math.min(Math.max(1, limit), 25));
    try {
      const schema = context.schema ?? await context.connector.introspect();
      if (!schema.tables.some(table => table.name === tableName)) throw new Error('Choose a table from the connected schema.');
      const query = schema.kind === 'mongodb'
        ? JSON.stringify({ collection: tableName, method: 'find', body: { limit: safeLimit } })
        : schema.kind === 'elasticsearch'
          ? JSON.stringify({ index: tableName, body: { size: safeLimit, query: { match_all: {} } } })
          : `SELECT * FROM ${schema.kind === 'mysql' ? '`' + tableName.replace(/`/g, '``') + '`' : '"' + tableName.replace(/"/g, '""') + '"'} LIMIT ${safeLimit}`;
      const result = await context.connector.executeQuery(query, { signal: context.signal });
      return {
        ok: true,
        summary: `${result.rowCount} row(s) from "${tableName}"`,
        data: {
          columns: result.columns.map((c: string) => c),
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
