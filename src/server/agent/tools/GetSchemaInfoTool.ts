import type { Tool } from '../types.js';

export const getSchemaInfoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_schema_info',
      description: 'Search or inspect the already loaded database schema, including qualified names, key relationships, and partial-inference labels.',
      parameters: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Optional: get detailed info for a specific table. Omit to list all tables.'
          },
          search: { type: 'string', description: 'Optional case-insensitive table or column search.' },
          includeRelationships: { type: 'boolean', description: 'Include foreign-key relationship hints (default true).' },
          maxTables: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum list results (default 20).' }
        },
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName, search, includeRelationships = true, maxTables = 20 } = input as { tableName?: string; search?: string; includeRelationships?: boolean; maxTables?: number };
    if (!context.schema) {
      return { ok: false, summary: 'No schema available', error: 'No database schema loaded' };
    }

    if (tableName) {
      const normalized = tableName.replace(/["`]/g, '').toLowerCase();
      const exact = context.schema.tables.filter((table) => table.qualifiedName === tableName);
      const qualified = exact.length > 0 ? exact : context.schema.tables.filter((table) => table.qualifiedName?.replace(/["`]/g, '').toLowerCase() === normalized);
      const bare = context.schema.tables.filter((table) => table.name.toLowerCase() === normalized);
      const matches = qualified.length > 0 ? qualified : bare;
      if (matches.length > 1) {
        return {
          ok: false,
          summary: `Table name "${tableName}" is ambiguous. Use a qualified name.`,
          error: 'Ambiguous table name',
          data: { errorCode: 'AMBIGUOUS_TABLE', choices: matches.map((table) => table.qualifiedName ?? table.name), retryable: true }
        };
      }
      const table = matches[0];
      if (!table) {
        return { ok: false, summary: `Table "${tableName}" not found`, error: 'Table not found' };
      }
      return {
        ok: true,
        summary: `Schema for table "${table.name}" (${table.columns.length} columns)`,
        data: {
          inference: context.schema.inference,
          table: {
            name: table.name,
            schema: table.schema,
            qualifiedName: table.qualifiedName ?? table.name,
            inference: table.inference ?? context.schema.inference,
            columns: table.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              primaryKey: c.primaryKey,
              foreignKey: c.foreignKey
            })),
            relationships: includeRelationships ? table.relationships ?? [] : undefined
          }
        }
      };
    }

    const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const matched = context.schema.tables.filter((table) => !needle || [table.name, table.qualifiedName, ...table.columns.map((column) => column.name)].some((value) => value?.toLowerCase().includes(needle)));
    const safeMax = Number.isInteger(maxTables) ? Math.min(50, Math.max(1, maxTables)) : 20;
    const tables = matched.slice(0, safeMax);
    return {
      ok: true,
      summary: `${matched.length} schema table(s) match${matched.length > tables.length ? `; showing ${tables.length}` : ''}`,
      data: {
        tables: tables.map((t) => ({
          name: t.name,
          schema: t.schema,
          qualifiedName: t.qualifiedName ?? t.name,
          inference: t.inference,
          columnCount: t.columns.length,
          columns: t.columns.map((c) => c.name),
          relationships: includeRelationships ? t.relationships ?? [] : undefined
        })),
        matchedTableCount: matched.length,
        returnedTableCount: tables.length,
        hasMore: matched.length > tables.length,
        inference: context.schema.inference
      }
    };
  }
};
