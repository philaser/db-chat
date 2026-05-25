import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const READ_ONLY_PREFIXES = ['select', 'with', 'show', 'describe', 'explain'];
const MANUAL_PREFIXES = [...READ_ONLY_PREFIXES, 'insert', 'update', 'delete', 'replace'];
const SAFE_BLOCKED_KEYWORDS = [
  'alter',
  'create',
  'delete',
  'drop',
  'grant',
  'insert',
  'replace',
  'revoke',
  'truncate',
  'update',
  'rename',
  'flush',
  'kill',
  'lock',
  'unlock',
  'call',
  'load',
  'handler',
  'shutdown',
  'purge',
  'reset',
  'start',
  'stop',
  'analyze',
  'check',
  'optimize',
  'repair',
  'backup',
  'restore',
  'install',
  'uninstall',
  'xa',
  'prepare',
  'execute',
  'deallocate',
  'replication'
];
const MANUAL_BLOCKED_KEYWORDS = [
  'alter',
  'create',
  'drop',
  'grant',
  'revoke',
  'truncate',
  'rename',
  'flush',
  'kill',
  'lock',
  'unlock',
  'call',
  'load',
  'handler',
  'shutdown',
  'purge',
  'reset',
  'start',
  'stop',
  'analyze',
  'check',
  'optimize',
  'repair',
  'backup',
  'restore',
  'install',
  'uninstall',
  'xa',
  'prepare',
  'execute',
  'deallocate',
  'replication'
];

export function stripSqlComments(query: string): string {
  return query
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

export function normalizeMysqlQuery(query: string): string {
  return stripSqlComments(query).replace(/\s+/g, ' ').trim();
}

export function validateMysqlReadOnlyQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
  const normalizedQuery = normalizeMysqlQuery(query);
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
        ? 'SAFE mode only allows SELECT, WITH, SHOW, DESCRIBE, and EXPLAIN.'
        : 'SAFE-off mode only allows validated reads and table row writes.',
      normalizedQuery
    };
  }

  const blockedKeywords = mode === 'safe' ? SAFE_BLOCKED_KEYWORDS : MANUAL_BLOCKED_KEYWORDS;
  const hasBlockedKeyword = blockedKeywords.some((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(normalizedQuery));
  if (hasBlockedKeyword) {
    return {
      safe: false,
      reason: mode === 'safe'
        ? 'SAFE mode blocks statements that can change database state.'
        : 'SAFE-off mode blocks schema, database, and administrative operations.',
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
