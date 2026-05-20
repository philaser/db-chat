import type { DatabaseSchema, GeneratedQuery, QueryResult } from '../../shared/types.js';
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

export function removeSqlBlocks(content: string): string {
  return content
    .replace(/```sql\s*[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function summarizeQueryResult(result: QueryResult): string {
  if (result.rowCount === 0) {
    return `I ran the safe read-only query and it returned no rows in ${result.elapsedMs} ms.`;
  }

  const previewRows = result.rows.slice(0, 5).map((row) => {
    return result.columns.map((column) => `${column}: ${String(row[column] ?? '')}`).join(', ');
  });
  const moreRows = result.rowCount > previewRows.length ? `\n\nShowing ${previewRows.length} of ${result.rowCount} returned rows in the data panel.` : '';

  return [
    `I ran the safe read-only query and it returned ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${result.elapsedMs} ms.`,
    '',
    previewRows.join('\n'),
    moreRows
  ].join('\n').trim();
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
    content: 'I can answer that by running a safe read-only query against the connected database.',
    query: {
      query,
      explanation: 'Local fallback query generated from the connected schema.',
      validation
    }
  };
}
