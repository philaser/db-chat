import { boundResult, resultLimit } from './resultLimits.js';
import { classifyQuery, QueryValidator, type SafetyLevel } from './QueryValidator.js';
import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  TableInfo
} from '../../shared/types.js';

export class PostgresConnector implements DatabaseConnector {
  private client: unknown = null;
  private config: ConnectionConfig | null = null;
  private safetyLevel: SafetyLevel = 'standard';
  private maxRows = 1000;

  setResultLimit(maxRows: number): void { this.maxRows = resultLimit(maxRows); }

  async connect(config: ConnectionConfig): Promise<void> {
    const { Client } = await import('pg');
    const host = config.host;
    const port = config.port ?? 5432;
    const database = config.database;
    if (!host) {
      throw new Error('PostgreSQL connection requires a host.');
    }

    this.close();
    const client = new Client({
      host: config.resolvedAddress ?? host,
      port,
      database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true, servername: host } : false,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      connectionTimeoutMillis: 10_000
    });
    client.on?.('error', () => {
      if (this.client === client) {
        this.client = null;
        this.config = null;
      }
    });
    await client.connect();
    this.client = client;
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    const client = this.requireClient();
    const [columnResult, relationshipResult] = await Promise.all([
      client.query(`
        select t.table_schema, t.table_name, c.column_name, c.data_type,
               c.is_nullable, c.ordinal_position,
               exists (
                 select 1 from pg_catalog.pg_constraint pk
                 join pg_catalog.pg_class pk_table on pk_table.oid = pk.conrelid
                 join pg_catalog.pg_namespace pk_schema on pk_schema.oid = pk_table.relnamespace
                 join pg_catalog.pg_attribute pk_column on pk_column.attrelid = pk_table.oid and pk_column.attnum = any(pk.conkey)
                 where pk.contype = 'p'
                   and pk_schema.nspname = t.table_schema
                   and pk_table.relname = t.table_name
                   and pk_column.attname = c.column_name
               ) as is_primary_key
        from information_schema.tables t
        join information_schema.columns c
          on c.table_schema = t.table_schema and c.table_name = t.table_name
        where t.table_type in ('BASE TABLE', 'VIEW')
          and t.table_schema not in ('pg_catalog', 'information_schema')
          and t.table_schema not like 'pg_toast%'
          and has_table_privilege(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT')
        order by t.table_schema, t.table_name, c.ordinal_position
      `),
      client.query(`
        select ns.nspname as table_schema, rel.relname as table_name,
               con.oid as constraint_id, con.conname as constraint_name,
               src.attname as column_name, refns.nspname as referenced_schema,
               refrel.relname as referenced_table, dst.attname as referenced_column
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class rel on rel.oid = con.conrelid
        join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
        join pg_catalog.pg_class refrel on refrel.oid = con.confrelid
        join pg_catalog.pg_namespace refns on refns.oid = refrel.relnamespace
        join lateral unnest(con.conkey, con.confkey) with ordinality
          as keys(source_number, target_number, position) on true
        join pg_catalog.pg_attribute src on src.attrelid = rel.oid and src.attnum = keys.source_number
        join pg_catalog.pg_attribute dst on dst.attrelid = refrel.oid and dst.attnum = keys.target_number
        where con.contype = 'f'
          and ns.nspname not in ('pg_catalog', 'information_schema')
          and has_table_privilege(rel.oid, 'SELECT')
          and has_table_privilege(refrel.oid, 'SELECT')
        order by ns.nspname, rel.relname, con.oid, keys.position
      `)
    ]);
    const tableMap = new Map<string, TableInfo>();
    for (const row of columnResult.rows as Record<string, unknown>[]) {
      const tableSchema = String(row.table_schema);
      const tableName = String(row.table_name);
      const qualifiedName = `${quoteIdentifier(tableSchema)}.${quoteIdentifier(tableName)}`;
      const table = tableMap.get(qualifiedName) ?? { schema: tableSchema, name: tableName, qualifiedName, columns: [], relationships: [] };
      table.columns.push({
        name: String(row.column_name),
        type: String(row.data_type || 'unknown'),
        nullable: row.is_nullable === 'YES',
        primaryKey: row.is_primary_key === true
      });
      tableMap.set(qualifiedName, table);
    }
    const constraints = new Map<string, NonNullable<TableInfo['relationships']>[number]>();
    for (const row of relationshipResult.rows as Record<string, unknown>[]) {
      const qualifiedName = `${quoteIdentifier(String(row.table_schema))}.${quoteIdentifier(String(row.table_name))}`;
      const table = tableMap.get(qualifiedName);
      if (!table) continue;
      const columnName = String(row.column_name);
      const key = String(row.constraint_id);
      const relationship: NonNullable<TableInfo['relationships']>[number] = constraints.get(key) ?? {
        columns: [],
        referencedSchema: String(row.referenced_schema),
        referencedTable: String(row.referenced_table),
        referencedColumns: []
      };
      relationship.columns.push(columnName);
      relationship.referencedColumns.push(String(row.referenced_column));
      if (!constraints.has(key)) { table.relationships!.push(relationship); constraints.set(key, relationship); }
      const column = table.columns.find((candidate) => candidate.name === columnName);
      if (column) column.foreignKey = { schema: relationship.referencedSchema, table: relationship.referencedTable, column: String(row.referenced_column) };
    }
    const tables = [...tableMap.values()];

    return {
      kind: 'postgres',
      label: this.config?.label ?? 'PostgreSQL database',
      tables
    };
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.safetyLevel = level;
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    const client = this.requireClient();

    const validation = QueryValidator.validate(query, this.safetyLevel, this.maxRows);
    if (!validation.ok) {
      throw new Error(validation.reason ?? 'Query validation failed.');
    }
    const effectiveQuery = validation.modifiedQuery ?? query;
    const signal = options?.signal;
    if (signal?.aborted) throw abortError(signal);

    const start = performance.now();
    let result;
    if (this.safetyLevel === 'safe') {
      await client.query('BEGIN READ ONLY');
      try { result = await queryWithSignal(client, effectiveQuery, signal, () => this.clearAndClose(client)); }
      finally { await client.query('ROLLBACK').catch(() => undefined); }
    } else result = await queryWithSignal(client, effectiveQuery, signal, () => this.clearAndClose(client));
    const elapsedMs = Math.round(performance.now() - start);
    const rows = result.rows as Record<string, unknown>[];

    if (result.fields.length === 0 && rows.length === 0) {
      const summary: Record<string, unknown> = { command: result.command };
      if (typeof result.rowCount === 'number') summary.rowCount = result.rowCount;
      return {
        columns: Object.keys(summary),
        rows: [summary],
        rowCount: 1,
        elapsedMs
      };
    }

    const columns = result.fields.map((f: { name: string }) => f.name);

    return boundResult({
      columns,
      rows,
      rowCount: rows.length,
      elapsedMs
    }, this.maxRows);
  }

  async *exportQuery(query: string, options?: { signal?: AbortSignal; batchSize?: number }): AsyncIterable<QueryResult> {
    if (classifyQuery(query) !== 'read') throw new Error('Exports require one explicit read-only query.');
    const client = this.requireClient();
    const signal = options?.signal;
    const batchSize = exportBatchSize(options?.batchSize);
    signal?.throwIfAborted();
    const cursor = `dbchat_export_${Date.now().toString(36)}`;
    const started = performance.now();
    let began = false;
    try {
      await queryWithSignal(client, 'BEGIN READ ONLY', signal, () => this.clearAndClose(client));
      began = true;
      await queryWithSignal(client, `DECLARE ${cursor} NO SCROLL CURSOR FOR ${query}`, signal, () => this.clearAndClose(client));
      for (;;) {
        const result = await queryWithSignal(client, `FETCH FORWARD ${batchSize} FROM ${cursor}`, signal, () => this.clearAndClose(client));
        const rows = result.rows as Record<string, unknown>[];
        const columns = result.fields.map(field => field.name);
        if (rows.length === 0) {
          if (result.fields.length) yield { columns, rows: [], rowCount: 0, elapsedMs: Math.round(performance.now() - started) };
          break;
        }
        yield { columns, rows, rowCount: rows.length, elapsedMs: Math.round(performance.now() - started) };
      }
    } finally {
      if (began && this.client === client) await client.query('ROLLBACK').catch(() => undefined);
    }
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected PostgreSQL database has no user tables or views.';
    }

    return schema.tables
      .map((table) => {
        const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Table ${table.qualifiedName ?? table.name}: ${columns}`;
      })
      .join('\n');
  }

  close(): void {
    (this.client as { end?: () => Promise<void> })?.end?.().catch(() => {});
    this.client = null;
    this.config = null;
  }

  private requireClient() {
    if (!this.client) {
      throw new Error('No database is connected.');
    }
    return this.client as PostgresClient;
  }

  private clearAndClose(client: PostgresClient): void {
    if (this.client === client) {
      this.client = null;
      this.config = null;
    }
    client.end?.().catch(() => undefined);
  }
}

interface PostgresResult {
  rows: unknown[];
  fields: Array<{ name: string }>;
  command: string;
  rowCount: number | null;
}

interface PostgresClient {
  query: (sql: string, params?: unknown[]) => Promise<PostgresResult>;
  end?: () => Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException('PostgreSQL query was cancelled.', 'AbortError');
}

function queryWithSignal(client: PostgresClient, sql: string, signal: AbortSignal | undefined, onAbort: () => void): Promise<PostgresResult> {
  if (!signal) return client.query(sql);
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      onAbort();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    client.query(sql).then(
      result => { if (!settled) { settled = true; resolve(result); } },
      error => { if (!settled) { settled = true; reject(error); } }
    ).finally(() => signal.removeEventListener('abort', abort));
  });
}

function quoteIdentifier(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }
function exportBatchSize(value = 500): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Export batch size must be a positive finite number.');
  return Math.min(10_000, Math.floor(value));
}
