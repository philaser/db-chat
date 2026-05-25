import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult,
  TableInfo
} from '../../shared/types.js';
import { validatePostgresqlReadOnlyQuery } from './postgresqlValidation.js';

export class PostgresConnector implements DatabaseConnector {
  private client: unknown = null;
  private config: ConnectionConfig | null = null;

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
      host,
      port,
      database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false
    });
    await client.connect();
    this.client = client;
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    const client = this.requireClient();

    const tableResult = await client.query(
      `select table_name from information_schema.tables where table_schema = $1 and table_type in ('BASE TABLE', 'VIEW') order by table_name`,
      ['public']
    );
    const tableRows = tableResult.rows as Record<string, unknown>[];

    const tables: TableInfo[] = [];
    for (const row of tableRows) {
      const tableName = String(row.table_name);
      const colResult = await client.query(
        `select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position`,
        ['public', tableName]
      );

      const pkResult = await client.query(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = $1::regclass and i.indisprimary`,
        [`public.${tableName}`]
      );
      const pkColumns = new Set((pkResult.rows as Record<string, unknown>[]).map((r) => String(r.attname)));

      const colRows = colResult.rows as Record<string, unknown>[];
      tables.push({
        name: tableName,
        columns: colRows.map((col) => ({
          name: String(col.column_name),
          type: String(col.data_type || 'unknown'),
          nullable: col.is_nullable === 'YES',
          primaryKey: pkColumns.has(String(col.column_name))
        }))
      });
    }

    return {
      kind: 'postgres',
      label: this.config?.label ?? 'PostgreSQL database',
      tables
    };
  }

  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
    return validatePostgresqlReadOnlyQuery(query, mode);
  }

  async executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult> {
    const client = this.requireClient();
    const validation = this.validateQuery(query, mode);
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    const start = performance.now();
    const result = await client.query(validation.normalizedQuery);
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

    return {
      columns,
      rows,
      rowCount: rows.length,
      elapsedMs
    };
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected PostgreSQL database has no user tables or views.';
    }

    return schema.tables
      .map((table) => {
        const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Table ${table.name}: ${columns}`;
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
    return this.client as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; fields: Array<{ name: string }>; command: string; rowCount: number | null }> };
  }
}
