import type { DatabaseSchema, GeneratedQuery, QueryExecutionMode, QueryResult } from '../../shared/types.js';
import { validateElasticsearchReadOnlyQuery } from '../connectors/elasticsearchValidation.js';
import { validateSqliteReadOnlyQuery } from '../connectors/sqliteValidation.js';

function firstTable(schema: DatabaseSchema | null): string | null {
  return schema?.tables[0]?.name ?? null;
}

export function buildSystemPrompt(
  schemaContext: string,
  kind: DatabaseSchema['kind'] = 'sqlite',
  mode: QueryExecutionMode = 'safe'
): string {
  const writesAllowed = mode === 'manual';
  const queryInstructions = kind === 'elasticsearch'
    ? [
      writesAllowed
        ? 'When the user asks to change Elasticsearch document data, infer the narrowest validated write request from the indices, mappings, and recent chat.'
        : 'When the user asks a data question, infer the best safe Elasticsearch search request you can from the indices, mappings, and recent chat.',
      writesAllowed
        ? 'SAFE mode is off. You may generate document index, update, and delete requests only when the user explicitly asks to change document data. Never generate index deletion, mapping changes, security/user operations, ingest pipelines, scripts, runtime mappings, or arbitrary endpoints.'
        : 'Generate only read-only Elasticsearch _search requests. Never generate writes, deletes, updates, ingest pipeline calls, scripts, runtime mappings, or unsafe endpoints.',
      writesAllowed
        ? 'When a request is useful, include exactly one fenced ```json block. Use {"index":"index-name","operation":"index","id":"optional-id","body":{"field":"value"}} to add a document, {"index":"index-name","operation":"update","id":"id","body":{"doc":{"field":"value"}}} to update document fields, {"index":"index-name","operation":"delete","id":"id"} to delete one document, or the read search shape {"index":"index-or-pattern","body":{"size":50,"query":{"match_all":{}}}}. Keep user-facing explanation brief because the app will execute the validated request and then ask you to explain the result.'
        : 'When a query is useful, include exactly one fenced ```json block with this shape: {"index":"index-or-pattern","body":{"size":50,"query":{"match_all":{}}}}. Keep any user-facing explanation outside the block brief because the app will execute the search and then ask you to explain the returned data.',
      'Prefer searches or aggregations that answer the actual question over broad document dumps. Use size limits for previews and aggregations for counts, rankings, and breakdowns.'
    ]
    : [
      writesAllowed
        ? 'When the user asks to change SQLite table data, infer the narrowest validated row-write query you can from the schema and recent chat.'
        : 'When the user asks a data question, infer the best safe SQLite analysis query you can from the schema and recent chat.',
      writesAllowed
        ? 'SAFE mode is off. You may generate table row inserts, updates, deletes, or replaces only when the user explicitly asks to change table data. Never generate schema changes, table drops, database attach/detach, create/alter operations, vacuum/reindex operations, or unsafe pragmas/functions.'
        : 'Generate only read-only SQLite. Never write, mutate, attach, detach, create, drop, update, insert, delete, or call unsafe pragmas/functions.',
      'When a query is useful, include exactly one fenced ```sql block with the query. Keep any user-facing explanation outside the block brief because the app will execute the SQL and then ask you to explain the returned data.',
      writesAllowed
        ? 'Keep write queries scoped to the requested table rows and prefer explicit WHERE clauses for updates and deletes.'
        : 'Prefer queries that answer the actual question over broad table dumps. Use LIMIT for previews and ORDER BY for ranked lists.'
    ];

  return [
    'You are DB Chat, a conversational data analyst for the user\'s connected database.',
    'Your job is to help the user think through the data, not just produce queries. Be warm, concise, and curious.',
    queryInstructions[0],
    'Handle complex analysis when useful: joins, grouping, filtering, date bucketing, ranking, comparisons, cohorts, and summary statistics.',
    queryInstructions[1],
    queryInstructions[2],
    'If the request is ambiguous, still offer the best useful query when a reasonable interpretation exists, and mention the assumption conversationally.',
    'If no database is connected or the schema cannot support the request, explain what is missing and suggest one or two good next questions.',
    queryInstructions[3],
    'Connected database schema:',
    schemaContext
  ].join('\n\n');
}

export function buildResultAnalysisPrompt(
  kind: DatabaseSchema['kind'] = 'sqlite',
  mode: QueryExecutionMode = 'safe'
): string {
  return [
    'You are DB Chat, a conversational data analyst explaining results from the user\'s connected database.',
    mode === 'manual'
      ? 'A validated read or data write has already been executed for the user with SAFE mode off.'
      : kind === 'elasticsearch'
      ? 'A safe read-only Elasticsearch search has already been executed for the user.'
      : 'A safe read-only SQLite query has already been executed for the user.',
    'Answer in a chatty, useful way: start with the direct takeaway, then add the most important supporting details.',
    'Analyze the returned data, do light arithmetic when helpful, call out trends, outliers, ranking, gaps, caveats, and comparisons that are visible in the rows.',
    'Give the user a ramp for the next question by ending with one natural follow-up they could ask or a useful next slice of the data.',
    'Do not include SQL, query text, fenced code blocks, JSON, or implementation details in the chat answer.',
    'For Elasticsearch results, also keep Elasticsearch request JSON out of the chat answer.',
    'If the result is empty, say what that likely means and suggest a next check.',
    'If the result is partial, say you are using the returned preview and avoid overclaiming.'
  ].join('\n');
}

export function extractQueryBlock(content: string, kind: DatabaseSchema['kind'] = 'sqlite'): string | null {
  const preferredLanguage = kind === 'elasticsearch' ? 'json' : 'sql';
  const preferredMatch = content.match(new RegExp(`\`\`\`${preferredLanguage}\\s*([\\s\\S]*?)\`\`\``, 'i'));
  if (preferredMatch?.[1]) {
    return preferredMatch[1].trim();
  }
  const match = content.match(/```(?:sql|json)\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

export const extractSqlBlock = extractQueryBlock;

export function removeSqlBlocks(content: string): string {
  return content
    .replace(/```(?:sql|json)\s*[\s\S]*?```/gi, '')
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
      content: 'Connect a SQLite database or Elasticsearch cluster and I can explain its structure, suggest useful question paths, and run safe read-only analysis for you.'
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

  if (schema.kind === 'elasticsearch') {
    const query = JSON.stringify({
      index: table,
      body: /count|how many/i.test(prompt)
        ? {
          size: 0,
          track_total_hits: true,
          query: { match_all: {} }
        }
        : {
          size: 50,
          query: { match_all: {} }
        }
    }, null, 2);
    const validation = validateElasticsearchReadOnlyQuery(query, 'safe');

    return {
      content: 'I can answer that by searching the connected Elasticsearch cluster with a safe read-only request.',
      query: {
        query,
        explanation: 'Local fallback search generated from the connected Elasticsearch mapping.',
        validation
      }
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
