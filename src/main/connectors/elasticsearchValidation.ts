import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const MAX_SAFE_SIZE = 500;
const SAFE_INDEX_PATTERN = /^[A-Za-z0-9._*,-]+$/;
const BLOCKED_KEYS = new Set([
  'delete',
  'doc',
  'id',
  'index',
  'pipeline',
  'runtime_mappings',
  'script',
  'script_fields',
  'source',
  'update',
  'upsert'
]);

export interface ElasticsearchSearchQuery {
  index: string;
  body: Record<string, unknown>;
}

export function parseElasticsearchSearchQuery(query: string): ElasticsearchSearchQuery {
  const parsed = JSON.parse(query) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Elasticsearch queries must be a JSON object.');
  }

  const index = parsed.index;
  const body = parsed.body ?? parsed.queryBody ?? parsed.search;
  if (typeof index !== 'string' || !index.trim()) {
    throw new Error('Elasticsearch SAFE queries must include an index.');
  }

  if (!isSafeIndexPattern(index)) {
    throw new Error('Elasticsearch SAFE mode only allows index names, aliases, wildcards, and comma-separated index patterns.');
  }

  if (!isRecord(body)) {
    throw new Error('Elasticsearch SAFE queries must include a body object.');
  }

  return {
    index: index.trim(),
    body: body as Record<string, unknown>
  };
}

export function validateElasticsearchReadOnlyQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Enter a query before running it.', normalizedQuery: trimmed };
  }

  if (mode !== 'safe') {
    return { safe: false, reason: 'The MVP keeps write-capable manual mode disabled.', normalizedQuery: trimmed };
  }

  try {
    const parsed = parseElasticsearchSearchQuery(trimmed);
    const size = parsed.body.size;
    if (typeof size === 'number' && size > MAX_SAFE_SIZE) {
      return {
        safe: false,
        reason: `Elasticsearch SAFE mode limits search size to ${MAX_SAFE_SIZE} documents.`,
        normalizedQuery: JSON.stringify(parsed, null, 2)
      };
    }

    const blockedKey = findBlockedKey(parsed.body);
    if (blockedKey) {
      return {
        safe: false,
        reason: `Elasticsearch SAFE mode blocks "${blockedKey}" in search bodies.`,
        normalizedQuery: JSON.stringify(parsed, null, 2)
      };
    }

    return {
      safe: true,
      reason: 'Read-only Elasticsearch search allowed by SAFE mode.',
      normalizedQuery: JSON.stringify(parsed, null, 2)
    };
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : 'Elasticsearch query JSON could not be parsed.',
      normalizedQuery: trimmed
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIndexPattern(index: string): boolean {
  const value = index.trim();
  return SAFE_INDEX_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
}

function findBlockedKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const blocked = findBlockedKey(item);
      if (blocked) return blocked;
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (BLOCKED_KEYS.has(normalizedKey) || normalizedKey.endsWith('_script')) {
      return key;
    }
    const blocked = findBlockedKey(child);
    if (blocked) return blocked;
  }

  return null;
}
