import type { DatabaseSchema, GeneratedQuery } from '../../shared/types.js';
import { validateSqliteReadOnlyQuery } from '../connectors/sqliteValidation.js';

function firstTable(schema: DatabaseSchema | null): string | null {
  return schema?.tables[0]?.name ?? null;
}

export function buildSystemPrompt(schemaContext: string): string {
  return [
    'You are DB Chat, an assistant that helps users understand and query their connected database.',
    'Generate only read-only SQL for SQLite in the MVP.',
    'When a query is useful, include it in a fenced ```sql block.',
    'Connected database schema:',
    schemaContext
  ].join('\n\n');
}

export function extractSqlBlock(content: string): string | null {
  const match = content.match(/```sql\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

export function buildLocalAssistantResponse(prompt: string, schema: DatabaseSchema | null): { content: string; query?: GeneratedQuery } {
  const table = firstTable(schema);
  if (!schema || schema.tables.length === 0) {
    return {
      content: 'Connect a SQLite database and I can explain its tables, suggest questions, and draft safe read-only SQL.'
    };
  }

  const wantsSchema = /schema|tables|columns|what data|explain|available/i.test(prompt);
  if (wantsSchema) {
    const content = schema.tables.map((item) => {
      const columns = item.columns.map((column) => `${column.name} (${column.type})`).join(', ');
      return `${item.name}: ${columns}`;
    }).join('\n');
    return {
      content: `Here is what I can see in the connected database:\n\n${content}`
    };
  }

  const query = /count|how many/i.test(prompt) && table
    ? `select count(*) as count from "${table}";`
    : `select * from "${table}" limit 50;`;
  const validation = validateSqliteReadOnlyQuery(query, 'safe');

  return {
    content: `I drafted a safe read-only SQLite query for the current database.\n\n\`\`\`sql\n${query}\n\`\`\``,
    query: {
      query,
      explanation: 'Local fallback query generated from the connected schema.',
      validation
    }
  };
}
