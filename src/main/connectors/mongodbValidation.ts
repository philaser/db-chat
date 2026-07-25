

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

export function parseMongoDBQuery(query: string): MongoDBParsedRequest {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeCollectionName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name.trim()) && !name.includes('..');
}

export function findBlockedAggregationStage(pipeline: unknown[]): string | null {
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

export function findBlockedKey(value: unknown): string | null {
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
