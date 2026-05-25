import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult,
  TableInfo
} from '../../shared/types.js';
import {
  parseMongoDBQuery,
  type MongoDBParsedRequest,
  type MongoDBReadRequest,
  type MongoDBWriteRequest,
  validateMongoDBReadOnlyQuery
} from './mongodbValidation.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT_CAP = 500;

export class MongoDBConnector implements DatabaseConnector {
  private client: unknown = null;
  private db: unknown = null;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    const { MongoClient } = await import('mongodb');
    const uri = config.mongodbUri ?? buildMongoUri(config);
    if (!uri) {
      throw new Error('MongoDB connection requires a host or URI.');
    }

    this.close();
    const client = new MongoClient(uri);
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
      .filter((c: { name: string }) => !c.name.startsWith('system.') && !c.name.startsWith('_'))
      .slice(0, 50);

    const tables: TableInfo[] = [];
    for (const coll of visible) {
      const sample = await db.collection(coll.name).findOne({}, { projection: {}, limit: 1 });
      const columns = sample ? sampleToColumns(sample) : [];
      tables.push({
        name: coll.name,
        columns
      });
    }

    return {
      kind: 'mongodb',
      label: this.config?.label ?? 'MongoDB database',
      tables
    };
  }

  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
    return validateMongoDBReadOnlyQuery(query, mode);
  }

  async executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult> {
    const validation = this.validateQuery(query, mode);
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    const parsed = parseMongoDBQuery(validation.normalizedQuery, mode) as MongoDBParsedRequest;

    if (parsed.method === 'insertOne' || parsed.method === 'updateOne' || parsed.method === 'deleteOne') {
      return this.executeDocumentWrite(parsed as MongoDBWriteRequest);
    }

    return this.executeRead(parsed as MongoDBReadRequest);
  }

  private async executeRead(parsed: MongoDBReadRequest): Promise<QueryResult> {
    const db = this.requireDb();
    const collection = db.collection(parsed.collection);
    const start = performance.now();

    if (parsed.method === 'count') {
      const filter = (parsed.body.filter ?? {}) as Record<string, unknown>;
      const count = await collection.countDocuments(filter);
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
      const hasLimit = pipeline.some((stage: unknown) =>
        typeof stage === 'object' && stage !== null && '$limit' in (stage as Record<string, unknown>)
      );
      const cappedPipeline = hasLimit ? pipeline : [...pipeline, { $limit: MAX_LIMIT_CAP }];
      const rows = await collection.aggregate(cappedPipeline).toArray();
      const elapsedMs = Math.round(performance.now() - start);
      const resultRows = rows.map((doc: Record<string, unknown>) => normalizeDocument(doc));
      const columns = collectColumns(resultRows);

      return {
        columns,
        rows: resultRows,
        rowCount: resultRows.length,
        elapsedMs
      };
    }

    const filter = (parsed.body.filter ?? {}) as Record<string, unknown>;
    const options = parsed.body.options as Record<string, unknown> | undefined;
    const userLimit = typeof parsed.body.limit === 'number' && parsed.body.limit > 0
      ? parsed.body.limit
      : DEFAULT_LIMIT;
    const limit = Math.min(userLimit, MAX_LIMIT_CAP);

    const cursor = collection.find(filter, options ?? {});
    cursor.limit(limit);
    const docs = await cursor.toArray();
    const elapsedMs = Math.round(performance.now() - start);
    const resultRows = docs.map((doc: Record<string, unknown>) => normalizeDocument(doc));
    const columns = collectColumns(resultRows);

    return {
      columns,
      rows: resultRows,
      rowCount: resultRows.length,
      elapsedMs
    };
  }

  private async executeDocumentWrite(parsed: MongoDBWriteRequest): Promise<QueryResult> {
    const db = this.requireDb();
    const collection = db.collection(parsed.collection);
    const start = performance.now();

    let result: Record<string, unknown> = {};
    if (parsed.method === 'insertOne') {
      const insertResult = await collection.insertOne(parsed.document ?? {});
      result = { operation: 'insertOne', insertedId: String(insertResult.insertedId), acknowledged: insertResult.acknowledged };
    } else if (parsed.method === 'updateOne') {
      const updateResult = await collection.updateOne(parsed.filter ?? {}, parsed.update ?? {});
      result = { operation: 'updateOne', matchedCount: updateResult.matchedCount, modifiedCount: updateResult.modifiedCount, acknowledged: updateResult.acknowledged };
    } else if (parsed.method === 'deleteOne') {
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

    return schema.tables
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
        aggregate: (pipeline: unknown[]) => { toArray: () => Promise<Record<string, unknown>[]> };
        countDocuments: (filter?: Record<string, unknown>) => Promise<number>;
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

function sampleToColumns(doc: Record<string, unknown>): ColumnInfo[] {
  return Object.entries(doc).map(([key, value]) => ({
    name: key,
    type: mongoValueType(value),
    nullable: true,
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
