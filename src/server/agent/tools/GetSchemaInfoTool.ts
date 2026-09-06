import type { Tool } from '../types.js';

export const getSchemaInfoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_schema_info',
      description: 'Get information about the database schema — tables, columns, types, and primary keys.',
      parameters: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Optional: get detailed info for a specific table. Omit to list all tables.'
          }
        },
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName } = input as { tableName?: string };
    if (!context.schema) {
      return { ok: false, summary: 'No schema available', error: 'No database schema loaded' };
    }

    if (tableName) {
      const table = context.schema.tables.find(
        (t) => t.name.toLowerCase() === tableName.toLowerCase()
      );
      if (!table) {
        return { ok: false, summary: `Table "${tableName}" not found`, error: 'Table not found' };
      }
      return {
        ok: true,
        summary: `Schema for table "${table.name}" (${table.columns.length} columns)`,
        data: {
          table: {
            name: table.name,
            columns: table.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              primaryKey: c.primaryKey
            }))
          }
        }
      };
    }

    return {
      ok: true,
      summary: `Database has ${context.schema.tables.length} table(s)`,
      data: {
        tables: context.schema.tables.map((t) => ({
          name: t.name,
          columnCount: t.columns.length,
          columns: t.columns.map((c) => c.name)
        }))
      }
    };
  }
};
