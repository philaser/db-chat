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
    const db = this.requireDb();
    const tableRows = db
      .prepare("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name")
      .all() as Array<{ name: string }>;

    const tables: TableInfo[] = tableRows.map((table) => {
      const columns = db.prepare(`pragma table_info('${table.name.replace(/'/g, "''")}')`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;

      return {
        name: table.name,
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type || 'unknown',
          nullable: column.notnull === 0,
          primaryKey: column.pk > 0
        }))
      };
    });

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
