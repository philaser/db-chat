import type { QueryExecutionMode, QueryValidationResult } from '../../shared/types.js';

const MAX_SAFE_LIMIT = 500;
const BLOCKED_AGGREGATION_STAGES = new Set([
  '$out',
  '$merge',
  '$function',
  '$where',
  '$graphLookup'
]);
const BLOCKED_KEYS = new Set([
  'function',
  'javascript',
  'where'
]);

export interface MongoDBRequest {
  collection: string;
  body: Record<string, unknown>;
}

export interface MongoDBReadRequest extends MongoDBRequest {
  method: 'find' | 'aggregate' | 'count';
}

export interface MongoDBWriteRequest {
  collection: string;
  method: 'insertOne' | 'updateOne' | 'deleteOne';
  filter?: Record<string, unknown>;
  document?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

export type MongoDBParsedRequest = MongoDBReadRequest | MongoDBWriteRequest;

export function parseMongoDBReadQuery(query: string): MongoDBReadRequest {
  const parsed = JSON.parse(query) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('MongoDB queries must be a JSON object.');
  }

  const collection = parsed.collection;
  if (typeof collection !== 'string' || !collection.trim()) {
    throw new Error('MongoDB SAFE queries must include a collection name.');
  }

  const method = parsed.method;
  if (method !== 'find' && method !== 'aggregate' && method !== 'count') {
    throw new Error('MongoDB SAFE mode only supports find, aggregate, and count methods.');
  }

  if (!isRecord(parsed.body)) {
    throw new Error('MongoDB SAFE queries must include a body object.');
  }

  return {
    collection: collection.trim(),
    method: method as 'find' | 'aggregate' | 'count',
    body: parsed.body as Record<string, unknown>
  };
}

export function validateMongoDBReadOnlyQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Enter a query before running it.', normalizedQuery: trimmed };
  }

  try {
    if (mode === 'manual') {
      return validateManualMongoDBQuery(trimmed);
    }

    const parsed = parseMongoDBReadQuery(trimmed);

    if (parsed.method === 'count') {
      const filter = parsed.body.filter;
      if (filter !== undefined && !isRecord(filter)) {
        return {
          safe: false,
          reason: 'MongoDB count filter must be an object or omitted.',
          normalizedQuery: JSON.stringify(parsed, null, 2)
        };
      }
      const blockedKey = findBlockedKey(parsed.body);
      if (blockedKey) {
        return {
          safe: false,
          reason: `MongoDB SAFE mode blocks "${blockedKey}" in request bodies.`,
          normalizedQuery: JSON.stringify(parsed, null, 2)
        };
      }
      return {
        safe: true,
        reason: 'Read-only MongoDB count allowed by SAFE mode.',
        normalizedQuery: JSON.stringify(parsed, null, 2)
      };
    }

    if (parsed.method === 'aggregate') {
      const pipeline = parsed.body.pipeline;
      if (!Array.isArray(pipeline)) {
        return {
          safe: false,
          reason: 'MongoDB aggregate body must include a pipeline array.',
          normalizedQuery: JSON.stringify(parsed, null, 2)
        };
      }

      const blockedStage = findBlockedAggregationStage(pipeline);
      if (blockedStage) {
        return {
          safe: false,
          reason: `MongoDB SAFE mode blocks aggregation stage "${blockedStage}".`,
          normalizedQuery: JSON.stringify(parsed, null, 2)
        };
      }

      const pipelineLimit = findAggregationLimit(pipeline);
      if (pipelineLimit !== null && typeof pipelineLimit === 'number') {
        if (pipelineLimit > MAX_SAFE_LIMIT) {
          return {
            safe: false,
            reason: `MongoDB SAFE mode limits aggregate to ${MAX_SAFE_LIMIT} documents per $limit.`,
            normalizedQuery: JSON.stringify(parsed, null, 2)
          };
        }
        if (pipelineLimit <= 0) {
          return {
            safe: false,
            reason: 'MongoDB aggregate $limit must be a positive integer.',
            normalizedQuery: JSON.stringify(parsed, null, 2)
          };
        }
      }
    }

    if (parsed.method === 'find') {
      const limit = parsed.body.limit;
      if (typeof limit === 'number') {
        if (limit > MAX_SAFE_LIMIT) {
          return {
            safe: false,
            reason: `MongoDB SAFE mode limits find results to ${MAX_SAFE_LIMIT} documents.`,
            normalizedQuery: JSON.stringify(parsed, null, 2)
          };
        }
        if (limit <= 0) {
          return {
            safe: false,
            reason: 'MongoDB find limit must be a positive integer.',
            normalizedQuery: JSON.stringify(parsed, null, 2)
          };
        }
      }
    }

    const blockedKey = findBlockedKey(parsed.body);
    if (blockedKey) {
      return {
        safe: false,
        reason: `MongoDB SAFE mode blocks "${blockedKey}" in request bodies.`,
        normalizedQuery: JSON.stringify(parsed, null, 2)
      };
    }

    return {
      safe: true,
      reason: 'Read-only MongoDB query allowed by SAFE mode.',
      normalizedQuery: JSON.stringify(parsed, null, 2)
    };
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : 'MongoDB query JSON could not be parsed.',
      normalizedQuery: trimmed
    };
  }
}

export function parseMongoDBQuery(query: string, mode: QueryExecutionMode): MongoDBParsedRequest {
  if (mode === 'safe') {
    return parseMongoDBReadQuery(query);
  }

  const parsed = JSON.parse(query) as unknown;
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return parseMongoDBReadQuery(query);
  }

  const method = parsed.method;
  if (method !== 'insertOne' && method !== 'updateOne' && method !== 'deleteOne') {
    return parseMongoDBReadQuery(query);
  }

  if (typeof parsed.collection !== 'string' || !isSafeCollectionName(parsed.collection)) {
    throw new Error('MongoDB document writes require a concrete collection name.');
  }

  if (method === 'deleteOne') {
    if (!isRecord(parsed.filter)) {
      throw new Error('MongoDB deleteOne requires a filter object.');
    }
    return {
      collection: parsed.collection.trim(),
      method: 'deleteOne',
      filter: parsed.filter as Record<string, unknown>
    };
  }

  if (method === 'updateOne') {
    if (!isRecord(parsed.filter)) {
      throw new Error('MongoDB updateOne requires a filter object.');
    }
    if (!isRecord(parsed.update)) {
      throw new Error('MongoDB updateOne requires an update object.');
    }
    const blockedKey = findBlockedKey(parsed.update);
    if (blockedKey) {
      throw new Error(`MongoDB manual mode blocks "${blockedKey}" in update bodies.`);
    }
    return {
      collection: parsed.collection.trim(),
      method: 'updateOne',
      filter: parsed.filter as Record<string, unknown>,
      update: parsed.update as Record<string, unknown>
    };
  }

  if (!isRecord(parsed.document)) {
    throw new Error('MongoDB insertOne requires a document object.');
  }

  const blockedKey = findBlockedKey(parsed.document);
  if (blockedKey) {
    throw new Error(`MongoDB manual mode blocks "${blockedKey}" in document bodies.`);
  }

  return {
    collection: parsed.collection.trim(),
    method: 'insertOne',
    document: parsed.document as Record<string, unknown>
  };
}

function validateManualMongoDBQuery(trimmed: string): QueryValidationResult {
  const parsed = parseMongoDBQuery(trimmed, 'manual');
  if (parsed.method === 'find' || parsed.method === 'aggregate' || parsed.method === 'count') {
    const safeValidation = validateMongoDBReadOnlyQuery(trimmed, 'safe');
    return safeValidation.safe
      ? {
        ...safeValidation,
        reason: 'Validated MongoDB read allowed with SAFE mode off.'
      }
      : safeValidation;
  }

  return {
    safe: true,
    reason: `Validated MongoDB document ${parsed.method} allowed with SAFE mode off.`,
    normalizedQuery: JSON.stringify(parsed, null, 2)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeCollectionName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name.trim()) && !name.includes('..');
}

function findBlockedAggregationStage(pipeline: unknown[]): string | null {
  for (const stage of pipeline) {
    if (!isRecord(stage)) continue;
    for (const key of Object.keys(stage)) {
      if (BLOCKED_AGGREGATION_STAGES.has(key)) {
        return key;
      }
    }
  }
  return null;
}

function findAggregationLimit(pipeline: unknown[]): number | null {
  for (const stage of pipeline) {
    if (!isRecord(stage)) continue;
    if ('$limit' in stage && typeof stage.$limit === 'number') {
      return stage.$limit;
    }
  }
  return null;
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
    const strippedKey = normalizedKey.startsWith('$') ? normalizedKey.slice(1) : normalizedKey;
    if (BLOCKED_KEYS.has(strippedKey) || normalizedKey.endsWith('_script')) {
      return key;
    }
    const blocked = findBlockedKey(child);
    if (blocked) return blocked;
  }

  return null;
}
