import type { DatabaseSchema, GeneratedQuery, QueryResult } from '../../shared/types.js';
import { validateSqliteReadOnlyQuery } from '../connectors/sqliteValidation.js';

function firstTable(schema: DatabaseSchema | null): string | null {
  return schema?.tables[0]?.name ?? null;
}

export function buildSystemPrompt(schemaContext: string): string {
  return [
    'You are DB Chat, a conversational data analyst for the user\'s connected database.',
    'Your job is to help the user think through the data, not just produce SQL. Be warm, concise, and curious.',
    'When the user asks a data question, infer the best safe SQLite analysis query you can from the schema and recent chat.',
    'Handle complex analysis when useful: joins, grouping, filtering, date bucketing, ranking, comparisons, cohorts, and summary statistics.',
    'Generate only read-only SQLite. Never write, mutate, attach, detach, create, drop, update, insert, delete, or call unsafe pragmas/functions.',
    'When a query is useful, include exactly one fenced ```sql block with the query. Keep any user-facing explanation outside the block brief because the app will execute the SQL and then ask you to explain the returned data.',
    'If the request is ambiguous, still offer the best useful query when a reasonable interpretation exists, and mention the assumption conversationally.',
    'If no database is connected or the schema cannot support the request, explain what is missing and suggest one or two good next questions.',
    'Prefer queries that answer the actual question over broad table dumps. Use LIMIT for previews and ORDER BY for ranked lists.',
    'Connected database schema:',
    schemaContext
  ].join('\n\n');
}

export function buildResultAnalysisPrompt(): string {
  return [
    'You are DB Chat, a conversational data analyst explaining results from the user\'s connected database.',
    'A safe read-only SQLite query has already been executed for the user.',
    'Answer in a chatty, useful way: start with the direct takeaway, then add the most important supporting details.',
    'Analyze the returned data, do light arithmetic when helpful, call out trends, outliers, ranking, gaps, caveats, and comparisons that are visible in the rows.',
    'Give the user a ramp for the next question by ending with one natural follow-up they could ask or a useful next slice of the data.',
    'Do not include SQL, query text, fenced code blocks, JSON, or implementation details in the chat answer.',
    'If the result is empty, say what that likely means and suggest a next check.',
    'If the result is partial, say you are using the returned preview and avoid overclaiming.'
  ].join('\n');
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
    return [
      `I checked the data with a safe read-only query and it returned no rows in ${result.elapsedMs} ms.`,
      'A good next check would be to loosen the filters or inspect the relevant table shape.'
    ].join('\n\n');
  }

  const previewRows = result.rows.slice(0, 5).map((row) => {
    return result.columns.map((column) => `${column}: ${String(row[column] ?? '')}`).join(', ');
  });
  const moreRows = result.rowCount > previewRows.length ? `\n\nShowing ${previewRows.length} of ${result.rowCount} returned rows in the data panel.` : '';

  return [
    `I checked the data with a safe read-only query and found ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${result.elapsedMs} ms.`,
    '',
    previewRows.join('\n'),
    moreRows,
    '',
    'A useful next step would be to ask for a breakdown, trend, or comparison from these results.'
  ].join('\n').trim();
}

export function buildLocalAssistantResponse(prompt: string, schema: DatabaseSchema | null): { content: string; query?: GeneratedQuery } {
  const table = firstTable(schema);
  if (!schema || schema.tables.length === 0) {
    return {
      content: 'Connect a SQLite database and I can explain its tables, suggest useful question paths, and run safe read-only analysis for you.'
    };
  }

  const wantsSchema = /schema|tables|columns|what data|explain|available/i.test(prompt);
  if (wantsSchema) {
    const content = schema.tables.map((item) => {
      const columns = item.columns.map((column) => `${column.name} (${column.type})`).join(', ');
      return `${item.name}: ${columns}`;
    }).join('\n');
    return {
      content: `Here is what I can see in the connected database:\n\n${content}\n\nA good next question could be: "What are the biggest patterns or counts in this data?"`
    };
  }

  const query = /count|how many/i.test(prompt) && table
    ? `select count(*) as count from "${table}";`
    : `select * from "${table}" limit 50;`;
  const validation = validateSqliteReadOnlyQuery(query, 'safe');

  return {
    content: 'I can answer that by checking the connected database with a safe read-only query.',
    query: {
      query,
      explanation: 'Local fallback query generated from the connected schema.',
      validation
    }
  };
}
