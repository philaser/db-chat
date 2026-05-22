import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const READ_ONLY_PREFIXES = ['select', 'with', 'pragma'];
const MANUAL_PREFIXES = [...READ_ONLY_PREFIXES, 'insert', 'update', 'delete', 'replace'];
const SAFE_BLOCKED_KEYWORDS = [
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
const MANUAL_BLOCKED_KEYWORDS = [
  'alter',
  'attach',
  'create',
  'detach',
  'drop',
  'reindex',
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

  const statements = normalizedQuery.split(';').map((part) => part.trim()).filter(Boolean);
  if (statements.length !== 1) {
    return {
      safe: false,
      reason: mode === 'safe'
        ? 'SAFE mode only allows one read-only statement at a time.'
        : 'SAFE-off mode only allows one validated statement at a time.',
      normalizedQuery
    };
  }

  const prefixes = mode === 'safe' ? READ_ONLY_PREFIXES : MANUAL_PREFIXES;
  if (!prefixes.some((prefix) => lower.startsWith(prefix))) {
    return {
      safe: false,
      reason: mode === 'safe'
        ? 'SAFE mode only allows SELECT, WITH, and schema PRAGMA reads.'
        : 'SAFE-off mode only allows validated reads and table row writes.',
      normalizedQuery
    };
  }

  if (lower.startsWith('pragma')) {
    const allowedPragma = /^pragma\s+(table_info|index_list|index_info|foreign_key_list|database_list)\s*\(/i.test(normalizedQuery)
      || /^pragma\s+(database_list|table_list)\s*$/i.test(normalizedQuery);
    if (!allowedPragma) {
      return {
        safe: false,
        reason: mode === 'safe'
          ? 'Only schema-inspection PRAGMA statements are allowed in SAFE mode.'
          : 'SAFE-off mode only allows schema-inspection PRAGMA statements.',
        normalizedQuery
      };
    }
  }

  const blockedKeywords = mode === 'safe' ? SAFE_BLOCKED_KEYWORDS : MANUAL_BLOCKED_KEYWORDS;
  const hasBlockedKeyword = blockedKeywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(normalizedQuery));
  if (hasBlockedKeyword) {
    return {
      safe: false,
      reason: mode === 'safe'
        ? 'SAFE mode blocks statements that can change database state.'
        : 'SAFE-off mode blocks schema, database, and other higher-level operations.',
      normalizedQuery
    };
  }

  return {
    safe: true,
    reason: mode === 'safe'
      ? 'Read-only query allowed by SAFE mode.'
      : 'Validated table read or row write allowed with SAFE mode off.',
    normalizedQuery
  };
}
