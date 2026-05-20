import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const READ_ONLY_PREFIXES = ['select', 'with', 'pragma'];
const BLOCKED_KEYWORDS = [
  'alter',
  'attach',
  'create',
  'delete',
  'detach',
  'drop',
  'insert',
  'replace',
  'reindex',
  'update',
  'vacuum'
];

export function stripSqlComments(query: string): string {
  return query
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

export function normalizeSqliteQuery(query: string): string {
  return stripSqlComments(query).replace(/\s+/g, ' ').trim();
}

export function validateSqliteReadOnlyQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
  const normalizedQuery = normalizeSqliteQuery(query);
  const lower = normalizedQuery.toLowerCase();

  if (!normalizedQuery) {
    return { safe: false, reason: 'Enter a query before running it.', normalizedQuery };
  }

  if (mode !== 'safe') {
    return { safe: false, reason: 'The MVP keeps write-capable manual mode disabled.', normalizedQuery };
  }

  const statements = normalizedQuery.split(';').map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) {
    return { safe: false, reason: 'SAFE mode only allows one read-only statement at a time.', normalizedQuery };
  }

  if (!READ_ONLY_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return { safe: false, reason: 'SAFE mode only allows SELECT, WITH, and schema PRAGMA reads.', normalizedQuery };
  }

  if (lower.startsWith('pragma')) {
    const allowedPragma = /^pragma\s+(table_info|index_list|index_info|foreign_key_list|database_list)\s*\(/i.test(normalizedQuery)
      || /^pragma\s+(database_list|table_list)\s*$/i.test(normalizedQuery);
    if (!allowedPragma) {
      return { safe: false, reason: 'Only schema-inspection PRAGMA statements are allowed in SAFE mode.', normalizedQuery };
    }
  }

  const hasBlockedKeyword = BLOCKED_KEYWORDS.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(normalizedQuery));
  if (hasBlockedKeyword) {
    return { safe: false, reason: 'SAFE mode blocks statements that can change database state.', normalizedQuery };
  }

  return { safe: true, reason: 'Read-only query allowed by SAFE mode.', normalizedQuery };
}
