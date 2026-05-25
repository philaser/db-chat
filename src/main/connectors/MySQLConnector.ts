import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult,
  TableInfo
} from '../../shared/types.js';
import { validateMysqlReadOnlyQuery } from './mysqlValidation.js';

export class MySQLConnector implements DatabaseConnector {
  private connection: unknown = null;
  private pool: unknown = null;
  private config: ConnectionConfig | null = null;

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
      port,
      database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      connectionLimit: 1
    });
    const connection = await pool.getConnection();
    await connection.ping();
    this.pool = pool;
    this.connection = connection;
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    const conn = this.requireConnection();
    const dbName = this.config?.database ?? await currentDatabase(conn);

    const [tableRows] = await conn.query(
      `select table_name as tableName from information_schema.tables where table_schema = ? and table_type in ('BASE TABLE', 'VIEW') order by table_name`,
      [dbName]
    ) as [Array<{ tableName: string }>, unknown];

    const tables: TableInfo[] = [];
    for (const row of tableRows) {
      const [columns] = await conn.query(
        `select column_name as columnName, data_type as dataType, is_nullable as isNullable, column_key as columnKey from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position`,
        [dbName, row.tableName]
      ) as [Array<{ columnName: string; dataType: string; isNullable: string; columnKey: string }>, unknown];

      tables.push({
        name: row.tableName,
        columns: columns.map((col) => ({
          name: col.columnName,
          type: col.dataType || 'unknown',
          nullable: col.isNullable === 'YES',
          primaryKey: col.columnKey === 'PRI'
        }))
      });
    }

    return {
      kind: 'mysql',
      label: this.config?.label ?? 'MySQL database',
      tables
    };
  }

  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
    return validateMysqlReadOnlyQuery(query, mode);
  }

  async executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult> {
    const conn = this.requireConnection();
    const validation = this.validateQuery(query, mode);
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    const normalized = validation.normalizedQuery;
    const isWrite = /^\s*(insert|update|delete|replace)\s/i.test(normalized);

    const start = performance.now();
    const [rawResult] = await conn.query(normalized) as [Array<Record<string, unknown>> | { affectedRows?: number; changedRows?: number; insertId?: number | string; warningStatus?: number }, unknown];
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
      return 'The connected MySQL database has no user tables or views.';
    }

    return schema.tables
      .map((table) => {
        const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Table ${table.name}: ${columns}`;
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
    return this.connection as { query: (sql: string, values?: unknown[]) => Promise<unknown>; ping: () => Promise<void> };
  }
}

async function currentDatabase(conn: { query: (sql: string, values?: unknown[]) => Promise<unknown> }): Promise<string> {
  const [rows] = await conn.query('select database() as db') as [Array<{ db: string }>, unknown];
  return rows[0]?.db ?? '';
}
