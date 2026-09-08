import { connect as connectSocket } from 'node:net';
import { boundResult, resultLimit } from './resultLimits.js';
import { classifyQuery, QueryValidator, type SafetyLevel } from './QueryValidator.js';
import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  TableInfo
} from '../../shared/types.js';

export class MySQLConnector implements DatabaseConnector {
  private connection: unknown = null;
  private pool: unknown = null;
  private config: ConnectionConfig | null = null;
  private safetyLevel: SafetyLevel = 'standard';
  private maxRows = 1000;

  setResultLimit(maxRows: number): void { this.maxRows = resultLimit(maxRows); }

  async connect(config: ConnectionConfig): Promise<void> {
    const { createPool } = await import('mysql2/promise');
    const host = config.host;
    const port = config.port ?? 3306;
    const database = config.database;
    if (!host) {
      throw new Error('MySQL connection requires a host.');
    }

    this.close();
    const pool = createPool({
      host,
      stream: config.resolvedAddress ? () => connectSocket({ host: config.resolvedAddress!, port }) : undefined,
      port,
      database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true, verifyIdentity: true } : undefined,
      connectionLimit: 1
    });
    try {
      const connection = await pool.getConnection();
      await connection.ping();
      this.pool = pool;
      this.connection = connection;
      this.config = config;
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async introspect(): Promise<DatabaseSchema> {
    const conn = this.requireConnection();
    const dbName = this.config?.database ?? await currentDatabase(conn);

    const [[columnRows], [relationshipRows]] = await Promise.all([
      conn.query(
        `select t.table_schema as tableSchema, t.table_name as tableName,
                c.column_name as columnName, c.data_type as dataType,
                c.is_nullable as isNullable, c.column_key as columnKey
         from information_schema.tables t
         join information_schema.columns c
           on c.table_schema = t.table_schema and c.table_name = t.table_name
         where t.table_schema = ? and t.table_type in ('BASE TABLE', 'VIEW')
         order by t.table_name, c.ordinal_position`,
        [dbName]
      ) as Promise<[Array<{ tableSchema: string; tableName: string; columnName: string; dataType: string; isNullable: string; columnKey: string }>, unknown]>,
      conn.query(
        `select k.table_schema as tableSchema, k.table_name as tableName,
                k.constraint_name as constraintName, k.column_name as columnName,
                k.referenced_table_schema as referencedSchema,
                k.referenced_table_name as referencedTable,
                k.referenced_column_name as referencedColumn
         from information_schema.key_column_usage k
         join information_schema.referential_constraints r
           on r.constraint_schema = k.constraint_schema
          and r.constraint_name = k.constraint_name
          and r.table_name = k.table_name
         where k.table_schema = ? and k.referenced_table_name is not null
         order by k.table_name, k.constraint_name, k.ordinal_position`,
        [dbName]
      ) as Promise<[Array<{ tableSchema: string; tableName: string; constraintName: string; columnName: string; referencedSchema: string; referencedTable: string; referencedColumn: string }>, unknown]>
    ]);

    const tableMap = new Map<string, TableInfo>();
    for (const row of columnRows) {
      const qualifiedName = `${quoteIdentifier(row.tableSchema)}.${quoteIdentifier(row.tableName)}`;
      const table = tableMap.get(qualifiedName) ?? { schema: row.tableSchema, name: row.tableName, qualifiedName, columns: [], relationships: [] };
      table.columns.push({
        name: row.columnName,
        type: row.dataType || 'unknown',
        nullable: row.isNullable === 'YES',
        primaryKey: row.columnKey === 'PRI'
      });
      tableMap.set(qualifiedName, table);
    }
    const constraints = new Map<string, NonNullable<TableInfo['relationships']>[number]>();
    for (const row of relationshipRows) {
      const qualifiedName = `${quoteIdentifier(row.tableSchema)}.${quoteIdentifier(row.tableName)}`;
      const table = tableMap.get(qualifiedName);
      if (!table) continue;
      const key = `${row.tableSchema}\0${row.tableName}\0${row.constraintName}`;
      const relationship = constraints.get(key) ?? {
        columns: [], referencedSchema: row.referencedSchema,
        referencedTable: row.referencedTable, referencedColumns: []
      };
      relationship.columns.push(row.columnName);
      relationship.referencedColumns.push(row.referencedColumn);
      if (!constraints.has(key)) { table.relationships!.push(relationship); constraints.set(key, relationship); }
      const column = table.columns.find((candidate) => candidate.name === row.columnName);
      if (column) column.foreignKey = { schema: row.referencedSchema, table: row.referencedTable, column: row.referencedColumn };
    }
    const tables = [...tableMap.values()];

    return {
      kind: 'mysql',
      label: this.config?.label ?? 'MySQL database',
      tables
    };
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    const conn = this.requireConnection();

    const validation = QueryValidator.validate(query, this.safetyLevel, this.maxRows);
    if (!validation.ok) {
      throw new Error(validation.reason ?? 'Query validation failed.');
    }
    const effectiveQuery = validation.modifiedQuery ?? query;
    const isWrite = validation.isWrite || validation.isDDL;
    if (options?.signal?.aborted) throw abortError(options.signal);

    const start = performance.now();
    let response: unknown;
    if (this.safetyLevel === 'safe') {
      await conn.query('START TRANSACTION READ ONLY');
      let queryError: unknown;
      try {
        response = await this.queryWithSignal(conn, { sql: effectiveQuery, timeout: 30_000 }, options?.signal);
      } catch (error) {
        queryError = error;
        throw error;
      } finally {
        try { await conn.query('ROLLBACK'); }
        catch (rollbackError) { if (queryError === undefined) throw rollbackError; }
      }
    } else response = await this.queryWithSignal(conn, { sql: effectiveQuery, timeout: 30_000 }, options?.signal);
    const [rawResult] = response as [Array<Record<string, unknown>> | { affectedRows?: number; changedRows?: number; insertId?: number | string; warningStatus?: number }, unknown];
    const elapsedMs = Math.round(performance.now() - start);

    if (isWrite && !Array.isArray(rawResult)) {
      const header = rawResult as { affectedRows?: number; changedRows?: number; insertId?: number | string; warningStatus?: number };
      const summary: Record<string, unknown> = {};
      if (typeof header.affectedRows === 'number') summary.affectedRows = header.affectedRows;
      if (typeof header.changedRows === 'number') summary.changedRows = header.changedRows;
      if (header.insertId !== undefined) summary.insertId = header.insertId;
      if (typeof header.warningStatus === 'number') summary.warningStatus = header.warningStatus;
      return {
        columns: Object.keys(summary),
        rows: [summary],
        rowCount: 1,
        elapsedMs
      };
    }

    const rows = rawResult as Record<string, unknown>[];
    const columns = rows.length
      ? Object.keys(rows[0])
      : [];

    return boundResult({
      columns,
      rows,
      rowCount: rows.length,
      elapsedMs
    }, this.maxRows);
  }

  async *exportQuery(query: string, options?: { signal?: AbortSignal; batchSize?: number }): AsyncIterable<QueryResult> {
    if (classifyQuery(query) !== 'read') throw new Error('Exports require one explicit read-only query.');
    const conn = this.requireConnection();
    const signal = options?.signal;
    const batchSize = exportBatchSize(options?.batchSize);
    signal?.throwIfAborted();
    await this.queryWithSignal(conn, { sql: 'START TRANSACTION READ ONLY', timeout: 30_000 }, signal);
    const stream = conn.connection?.query({ sql: query, timeout: 30_000 }).stream({ highWaterMark: batchSize });
    if (!stream) {
      await conn.query('ROLLBACK').catch(() => undefined);
      throw new Error('This MySQL connection does not support streaming exports.');
    }
    const started = performance.now();
    let columns: string[] = [];
    const fields = (items: Array<{ name: string }>) => { columns = items.map(item => item.name); };
    const abort = () => {
      stream.destroy(abortError(signal!));
      invalidateConnection();
    };
    const invalidateConnection = () => {
      conn.destroy?.();
      if (this.connection !== conn) return;
      const pool = this.pool as MySQLPool | null;
      this.connection = null; this.pool = null; this.config = null;
      pool?.end?.().catch(() => undefined);
    };
    stream.on('fields', fields);
    signal?.addEventListener('abort', abort, { once: true });
    let rows: Record<string, unknown>[] = [];
    let completed = false;
    try {
      for await (const row of stream) {
        if (signal?.aborted) throw abortError(signal);
        const record = row as Record<string, unknown>;
        if (!columns.length) columns = Object.keys(record);
        rows.push(record);
        if (rows.length === batchSize) {
          yield { columns, rows, rowCount: rows.length, elapsedMs: Math.round(performance.now() - started) };
          rows = [];
        }
      }
      completed = true;
      if (rows.length || columns.length) yield { columns, rows, rowCount: rows.length, elapsedMs: Math.round(performance.now() - started) };
    } finally {
      signal?.removeEventListener('abort', abort);
      stream.off('fields', fields);
      if (!stream.destroyed) stream.destroy();
      if (completed && this.connection === conn) await conn.query('ROLLBACK').catch(() => undefined);
      else if (!completed) invalidateConnection();
    }
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected MySQL database has no user tables or views.';
    }

    return schema.tables
      .map((table) => {
        const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Table ${table.qualifiedName ?? table.name}: ${columns}`;
      })
      .join('\n');
  }

  close(): void {
    (this.connection as { release?: () => void })?.release?.();
    (this.pool as { end?: () => Promise<void> })?.end?.().catch(() => {});
    this.connection = null;
    this.pool = null;
    this.config = null;
  }

  private requireConnection() {
    if (!this.connection) {
      throw new Error('No database is connected.');
    }
    return this.connection as MySQLConnection;
  }

  private async queryWithSignal(conn: MySQLConnection, sql: { sql: string; timeout: number }, signal?: AbortSignal): Promise<unknown> {
    if (!signal) return conn.query(sql);
    if (signal.aborted) throw abortError(signal);
    return new Promise((resolve, reject) => {
      const abort = () => {
        conn.destroy?.();
        if (this.connection === conn) {
          const pool = this.pool as MySQLPool | null;
          this.connection = null;
          this.pool = null;
          this.config = null;
          pool?.end?.().catch(() => undefined);
        }
        reject(abortError(signal));
      };
      signal.addEventListener('abort', abort, { once: true });
      conn.query(sql).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}

interface MySQLConnection {
  query: (sql: string | { sql: string; timeout: number }, values?: unknown[]) => Promise<unknown>;
  ping: () => Promise<void>;
  destroy?: () => void;
  connection?: { query: (options: { sql: string; timeout: number }) => { stream: (options: { highWaterMark: number }) => MySQLRowStream } };
}

interface MySQLRowStream extends AsyncIterable<unknown> {
  destroyed?: boolean;
  destroy: (error?: Error) => void;
  on: (event: 'fields', listener: (fields: Array<{ name: string }>) => void) => void;
  off: (event: 'fields', listener: (fields: Array<{ name: string }>) => void) => void;
}

interface MySQLPool { end?: () => Promise<void> }

function abortError(signal: AbortSignal): DOMException {
  const message = signal.reason instanceof Error ? signal.reason.message : 'MySQL query was cancelled.';
  return signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException(message, 'AbortError');
}

async function currentDatabase(conn: MySQLConnection): Promise<string> {
  const [rows] = await conn.query('select database() as db') as [Array<{ db: string }>, unknown];
  return rows[0]?.db ?? '';
}

function quoteIdentifier(value: string): string { return '`' + value.replaceAll('`', '``') + '`'; }
function exportBatchSize(value = 500): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Export batch size must be a positive finite number.');
  return Math.min(10_000, Math.floor(value));
}
