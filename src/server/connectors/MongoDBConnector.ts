import { pinnedLookup } from './pinnedLookup.js';
import { boundResult, resultLimit } from './resultLimits.js';
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  TableInfo,
  SafetyLevel
} from '../../shared/types.js';
import {
  parseMongoDBQuery,
  findBlockedAggregationStage,
  findBlockedKey,
  type MongoDBParsedRequest,
  type MongoDBReadRequest,
  type MongoDBWriteRequest
} from './mongodbValidation.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT_CAP = 500;
const SCHEMA_SAMPLE_DOCUMENTS = 20;

export class MongoDBConnector implements DatabaseConnector {
  private client: unknown = null;
  private db: unknown = null;
  private config: ConnectionConfig | null = null;
  private safetyLevel: SafetyLevel = 'standard';
  private maxRows = MAX_LIMIT_CAP;

  setResultLimit(maxRows: number): void { this.maxRows = resultLimit(maxRows, MAX_LIMIT_CAP); }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  async connect(config: ConnectionConfig): Promise<void> {
    const { MongoClient } = await import('mongodb');
    const uri = config.mongodbUri ?? buildMongoUri(config);
    if (!uri) {
      throw new Error('MongoDB connection requires a host or URI.');
    }

    this.close();
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 35_000, directConnection: config.mongodbDirectConnection, ...(config.resolvedAddress ? { lookup: pinnedLookup(config.resolvedAddress) } : {}) });
    await client.connect();
    const database = config.database;
    if (!database) {
      (client as { close: () => Promise<void> }).close().catch(() => {});
      throw new Error('MongoDB connection requires a database name.');
    }
    this.client = client;
    this.db = (client as { db: (name: string) => unknown }).db(database);
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    const db = this.requireDb();
    const collections = await db.listCollections().toArray();
    const visible = collections
      .filter((c: { name: string }) => !c.name.startsWith('system.') && !c.name.startsWith('_'));

    const tables: TableInfo[] = [];
    let sampledDocuments = 0;
    for (const coll of visible) {
      const samples = await db.collection(coll.name).find({}, { projection: {}, maxTimeMS: 30_000 }).limit(SCHEMA_SAMPLE_DOCUMENTS).toArray();
      sampledDocuments += samples.length;
      const columns = samplesToColumns(samples);
      tables.push({
        name: coll.name,
        inference: { partial: true, sampledDocuments: samples.length, maxDocuments: SCHEMA_SAMPLE_DOCUMENTS, note: 'Sampled field names and types; absence is not proof a field does not exist.' },
        columns
      });
    }

    return {
      kind: 'mongodb',
      label: this.config?.label ?? 'MongoDB database',
      tables,
      inference: {
        partial: true,
        sampledDocuments,
        maxDocuments: SCHEMA_SAMPLE_DOCUMENTS * visible.length,
        note: `Field inference is based on at most ${SCHEMA_SAMPLE_DOCUMENTS} documents per collection. Sparse or differently shaped fields may be absent.`
      }
    };
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    const parsed = parseMongoDBQuery(query) as MongoDBParsedRequest;
    const blockedKey = findBlockedKey(parsed);
    if (blockedKey) throw new Error(`MongoDB blocked key "${blockedKey}".`);

    if (parsed.method === 'insertOne' || parsed.method === 'updateOne' || parsed.method === 'deleteOne') {
      if (this.safetyLevel === 'safe') {
        throw new Error('MongoDB write operations are blocked in safe mode.');
      }
      return this.executeDocumentWrite(parsed as MongoDBWriteRequest);
    }

    return this.executeRead(parsed as MongoDBReadRequest, options?.signal);
  }

  private async executeRead(parsed: MongoDBReadRequest, signal?: AbortSignal): Promise<QueryResult> {
    const db = this.requireDb();
    const collection = db.collection(parsed.collection);
    const start = performance.now();

    if (parsed.method === 'count') {
      const filter = (parsed.body.filter ?? {}) as Record<string, unknown>;
      const count = await collection.countDocuments(filter, { maxTimeMS: 30_000, signal });
      const elapsedMs = Math.round(performance.now() - start);
      return {
        columns: ['count'],
        rows: [{ count }],
        rowCount: 1,
        elapsedMs
      };
    }

    if (parsed.method === 'aggregate') {
      const pipeline = (parsed.body.pipeline ?? []) as unknown[];
      const blockedStage = findBlockedAggregationStage(pipeline);
      if (blockedStage) {
        throw new Error(`MongoDB aggregation stage "${blockedStage}" is blocked.`);
      }
      // Always append a terminal cap: an earlier limit can be expanded by unwind.
      const cappedPipeline = [...pipeline, { $limit: this.maxRows + 1 }];
      const rows = await collection.aggregate(cappedPipeline, { maxTimeMS: 30_000, signal }).toArray();
      const elapsedMs = Math.round(performance.now() - start);
      const resultRows = rows.map((doc: Record<string, unknown>) => normalizeDocument(doc));
      const columns = collectColumns(resultRows);

      return boundResult({ columns, rows: resultRows, rowCount: resultRows.length, elapsedMs }, this.maxRows);
    }

    const filter = (parsed.body.filter ?? {}) as Record<string, unknown>;
    const options = parsed.body.options as Record<string, unknown> | undefined;
    const userLimit = typeof parsed.body.limit === 'number' && parsed.body.limit > 0
      ? parsed.body.limit
      : DEFAULT_LIMIT;
    const limit = resultLimit(userLimit, this.maxRows);

    const cursor = collection.find(filter, { ...options, maxTimeMS: 30_000, signal });
    cursor.limit(parsed.body.limit === undefined || userLimit > this.maxRows ? limit + 1 : limit);
    const docs = await cursor.toArray();
    const elapsedMs = Math.round(performance.now() - start);
    const resultRows = docs.map((doc: Record<string, unknown>) => normalizeDocument(doc));
    const columns = collectColumns(resultRows);

    return boundResult({ columns, rows: resultRows, rowCount: resultRows.length, elapsedMs }, limit);
  }

  private async executeDocumentWrite(parsed: MongoDBWriteRequest): Promise<QueryResult> {
    const db = this.requireDb();
    const collection = db.collection(parsed.collection);
    const start = performance.now();

    let result: Record<string, unknown> = {};
    if (parsed.method === 'insertOne') {
      const blocked = findBlockedKey(parsed.document ?? {});
      if (blocked) {
        throw new Error(`MongoDB blocked key "${blocked}" in insert document.`);
      }
      const insertResult = await collection.insertOne(parsed.document ?? {});
      result = { operation: 'insertOne', insertedId: String(insertResult.insertedId), acknowledged: insertResult.acknowledged };
    } else if (parsed.method === 'updateOne') {
      const updateBlocked = findBlockedKey(parsed.update ?? {});
      if (updateBlocked) {
        throw new Error(`MongoDB blocked key "${updateBlocked}" in update body.`);
      }
      const filterBlocked = findBlockedKey(parsed.filter ?? {});
      if (filterBlocked) {
        throw new Error(`MongoDB blocked key "${filterBlocked}" in update filter.`);
      }
      const updateResult = await collection.updateOne(parsed.filter ?? {}, parsed.update ?? {});
      result = { operation: 'updateOne', matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount, acknowledged: updateResult.acknowledged };
    } else if (parsed.method === 'deleteOne') {
      const filterBlocked = findBlockedKey(parsed.filter ?? {});
      if (filterBlocked) {
        throw new Error(`MongoDB blocked key "${filterBlocked}" in delete filter.`);
      }
      const deleteResult = await collection.deleteOne(parsed.filter ?? {});
      result = { operation: 'deleteOne', deletedCount: deleteResult.deletedCount, acknowledged: deleteResult.acknowledged };
    }

    const elapsedMs = Math.round(performance.now() - start);
    return {
      columns: Object.keys(result),
      rows: [result],
      rowCount: 1,
      elapsedMs
    };
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected MongoDB database has no visible collections.';
    }

    return 'Field inference is partial, based on at most ' + SCHEMA_SAMPLE_DOCUMENTS + ' documents per collection. Sparse fields may be absent.\n' + schema.tables
      .map((coll) => {
        const fields = coll.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `MongoDB collection ${coll.name}: ${fields || 'no sample fields available'}`;
      })
      .join('\n');
  }

  close(): void {
    (this.client as { close: () => Promise<void> } | null)?.close?.()?.catch(() => {});
    this.client = null;
    this.db = null;
    this.config = null;
  }

  private requireDb() {
    if (!this.db) {
      throw new Error('No database is connected.');
    }
    return this.db as {
      listCollections: () => { toArray: () => Promise<Array<{ name: string }>> };
      collection: (name: string) => {
        findOne: (filter: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
        find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => { limit: (n: number) => { toArray: () => Promise<Record<string, unknown>[]> } & Record<string, unknown> } & { toArray: () => Promise<Record<string, unknown>[]> };
        aggregate: (pipeline: unknown[], options?: { maxTimeMS: number; signal?: AbortSignal }) => { toArray: () => Promise<Record<string, unknown>[]> };
        countDocuments: (filter?: Record<string, unknown>, options?: { maxTimeMS: number; signal?: AbortSignal }) => Promise<number>;
        insertOne: (doc: Record<string, unknown>) => Promise<{ insertedId: unknown; acknowledged: boolean }>;
        updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => Promise<{ matchedCount: number; modifiedCount: number; acknowledged: boolean }>;
        deleteOne: (filter: Record<string, unknown>) => Promise<{ deletedCount: number; acknowledged: boolean }>;
      };
    };
  }
}

function buildMongoUri(config: ConnectionConfig): string {
  const host = config.host;
  if (!host) return '';

  const port = config.port ?? 27017;
  const credentials = config.username && config.password
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : '';
  const params: string[] = [];
  if (config.ssl) {
    params.push(`tls=true`);
  }
  if (config.authDatabase) {
    params.push(`authSource=${encodeURIComponent(config.authDatabase)}`);
  }
  const query = params.length ? `?${params.join('&')}` : '';

  return `mongodb://${credentials}${host}:${port}/${query}`;
}

function samplesToColumns(documents: Record<string, unknown>[]): ColumnInfo[] {
  const fields = new Map<string, Set<string>>();
  const appearances = new Map<string, number>();
  for (const document of documents) {
    for (const [key, value] of Object.entries(document)) {
      const types = fields.get(key) ?? new Set<string>();
      types.add(mongoValueType(value));
      fields.set(key, types);
      appearances.set(key, (appearances.get(key) ?? 0) + 1);
    }
  }
  return [...fields.entries()].map(([key, types]) => ({
    name: key,
    type: [...types].sort().join(' | '),
    nullable: (appearances.get(key) ?? 0) < documents.length || types.has('null'),
    primaryKey: key === '_id'
  }));
}

function mongoValueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object' && (value as Record<string, unknown>)._bsontype) return 'objectid';
  return typeof value;
}

function normalizeDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id' && typeof value === 'object' && value !== null) {
      normalized[key] = String(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
      normalized[key] = JSON.stringify(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}
