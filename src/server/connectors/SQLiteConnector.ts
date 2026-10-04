import { SQLiteExecution } from './sqliteExecution.js';
import { boundResult, resultLimit } from './resultLimits.js';
import Database from 'better-sqlite3';
import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryResult,
  TableInfo
} from '../../shared/types.js';
import { classifyQuery, QueryValidator, type SafetyLevel } from './QueryValidator.js';

export class SQLiteConnector implements DatabaseConnector {
  private db: Database.Database | null = null;
  private config: ConnectionConfig | null = null;
  private safetyLevel: SafetyLevel = 'standard';
  private maxRows = 1000;
  private readonly execution = new SQLiteExecution();

  constructor(private readonly queryTimeoutMs = 30_000) {}

  setResultLimit(maxRows: number): void { this.maxRows = resultLimit(maxRows); }

  async connect(config: ConnectionConfig): Promise<void> {
    if (!config.databasePath) {
      throw new Error('SQLite connection requires a database file.');
    }
    this.close();
    this.db = new Database(config.databasePath, { fileMustExist: true, readonly: this.safetyLevel === 'safe' });
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    this.requireDb();
    const metadata = await this.execution.execute(this.config!.databasePath!, `
      SELECT m.name AS table_name, p.name AS column_name, p.type AS column_type,
             p.[notnull] AS is_not_null, p.pk AS primary_key
      FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p
      WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
      ORDER BY m.name, p.cid
    `, true, 20_000, this.queryTimeoutMs);
    if (metadata.rows.length > 20_000) throw new Error('SQLite schema is too large. Use a database with fewer visible columns.');
    const byTable = new Map<string, TableInfo>();
    for (const row of metadata.rows) {
      const name = String(row.table_name);
      const table = byTable.get(name) ?? { name, columns: [] };
      if (row.column_name !== null) table.columns.push({
        name: String(row.column_name), type: String(row.column_type || 'unknown'),
        nullable: row.is_not_null === 0, primaryKey: Number(row.primary_key) > 0
      });
      byTable.set(name, table);
    }
    const tables = [...byTable.values()];

    return {
      kind: 'sqlite',
      label: this.config?.label ?? 'SQLite database',
      tables
    };
  }

  setSafetyLevel(level: SafetyLevel): void {
    if (this.safetyLevel === level) return;
    const config = this.config;
    this.close();
    this.safetyLevel = level;
    if (config?.databasePath) {
      this.db = new Database(config.databasePath, { fileMustExist: true, readonly: level === 'safe' });
      this.config = config;
    }
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    options?.signal?.throwIfAborted();
    this.requireDb();
    const validation = QueryValidator.validate(query, this.safetyLevel, this.maxRows);
    if (!validation.ok) throw new Error(validation.reason ?? 'Query validation failed.');
    const result = await this.execution.execute(
      this.config!.databasePath!, validation.modifiedQuery ?? query,
      this.safetyLevel === 'safe', this.maxRows, this.queryTimeoutMs, options?.signal
    );
    return boundResult(result, this.maxRows);
  }

  async *exportQuery(query: string, options?: { signal?: AbortSignal; batchSize?: number }): AsyncIterable<QueryResult> {
    if (classifyQuery(query) !== 'read') throw new Error('Exports require one explicit read-only query.');
    const batchSize = exportBatchSize(options?.batchSize);
    this.requireDb();
    yield* this.execution.export(this.config!.databasePath!, query, batchSize, this.queryTimeoutMs, options?.signal);
  }

  async getContextForPrompt(): Promise<string> {
    const schema = await this.introspect();
    if (schema.tables.length === 0) {
      return 'The connected SQLite database has no user tables or views.';
    }

    return schema.tables
      .map((table) => {
        const columns = table.columns.map((column) => `${column.name} ${column.type}`).join(', ');
        return `Table ${table.name}: ${columns}`;
      })
      .join('\n');
  }

  close(): void {
    this.execution.close();
    this.db?.close();
    this.db = null;
    this.config = null;
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('No database is connected.');
    }
    return this.db;
  }

}

function exportBatchSize(value = 500): number {
  if (!Number.isFinite(value) || value < 1) throw new Error('Export batch size must be a positive finite number.');
  return Math.min(10_000, Math.floor(value));
}
