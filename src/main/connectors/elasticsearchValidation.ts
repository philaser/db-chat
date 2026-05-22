import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const MAX_SAFE_SIZE = 500;
const SAFE_INDEX_PATTERN = /^[A-Za-z0-9._*,-]+$/;
const SAFE_DOCUMENT_INDEX_PATTERN = /^[A-Za-z0-9._-]+$/;
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

export interface ElasticsearchDocumentWriteQuery {
  index: string;
  operation: 'index' | 'update' | 'delete';
  id?: string;
  body?: Record<string, unknown>;
}

export type ElasticsearchQuery = ElasticsearchSearchQuery | ElasticsearchDocumentWriteQuery;

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

  try {
    if (mode === 'manual') {
      return validateManualElasticsearchQuery(trimmed);
    }

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

export function parseElasticsearchQuery(query: string, mode: QueryExecutionMode): ElasticsearchQuery {
  if (mode === 'safe') {
    return parseElasticsearchSearchQuery(query);
  }

  const parsed = JSON.parse(query) as unknown;
  if (!isRecord(parsed) || typeof parsed.operation !== 'string') {
    return parseElasticsearchSearchQuery(query);
  }

  if (parsed.operation !== 'index' && parsed.operation !== 'update' && parsed.operation !== 'delete') {
    throw new Error('SAFE-off Elasticsearch mode only allows search, index, update, and delete document operations.');
  }

  if (typeof parsed.index !== 'string' || !isSafeDocumentIndex(parsed.index)) {
    throw new Error('Elasticsearch document writes require one concrete index name.');
  }

  const id = parsed.id;
  if (id !== undefined && (typeof id !== 'string' || !isSafeDocumentId(id))) {
    throw new Error('Elasticsearch document ids must be plain id strings.');
  }

  if ((parsed.operation === 'update' || parsed.operation === 'delete') && !id) {
    throw new Error(`Elasticsearch ${parsed.operation} document operations require an id.`);
  }

  if (parsed.operation === 'delete') {
    if (parsed.body !== undefined) {
      throw new Error('Elasticsearch delete document operations must not include a body.');
    }
    return { index: parsed.index.trim(), operation: parsed.operation, id };
  }

  if (!isRecord(parsed.body)) {
    throw new Error(`Elasticsearch ${parsed.operation} document operations require a body object.`);
  }

  if (parsed.operation === 'update') {
    if (!isRecord(parsed.body.doc) || Object.keys(parsed.body).some((key) => key !== 'doc')) {
      throw new Error('Elasticsearch update document operations only allow a body.doc object.');
    }
  }

  return {
    index: parsed.index.trim(),
    operation: parsed.operation,
    id,
    body: parsed.body
  };
}

function validateManualElasticsearchQuery(trimmed: string): QueryValidationResult {
  const parsed = parseElasticsearchQuery(trimmed, 'manual');
  if (!('operation' in parsed)) {
    const safeValidation = validateElasticsearchReadOnlyQuery(trimmed, 'safe');
    return safeValidation.safe
      ? {
        ...safeValidation,
        reason: 'Validated Elasticsearch search allowed with SAFE mode off.'
      }
      : safeValidation;
  }

  return {
    safe: true,
    reason: `Validated Elasticsearch document ${parsed.operation} allowed with SAFE mode off.`,
    normalizedQuery: JSON.stringify(parsed, null, 2)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIndexPattern(index: string): boolean {
  const value = index.trim();
  return SAFE_INDEX_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
}

function isSafeDocumentIndex(index: string): boolean {
  const value = index.trim();
  return SAFE_DOCUMENT_INDEX_PATTERN.test(value) && !value.includes('..');
}

function isSafeDocumentId(id: string): boolean {
  return Boolean(id.trim()) && !/[/?#]/.test(id);
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
