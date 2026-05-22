import Database from 'better-sqlite3';
import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult,
  TableInfo
} from '../../shared/types.js';
import { validateSqliteReadOnlyQuery } from './sqliteValidation.js';

export class SQLiteConnector implements DatabaseConnector {
  private db: Database.Database | null = null;
  private config: ConnectionConfig | null = null;

  async connect(config: ConnectionConfig): Promise<void> {
    if (!config.databasePath) {
      throw new Error('SQLite connection requires a database file.');
    }
    this.close();
    this.db = new Database(config.databasePath, { fileMustExist: true });
    this.config = config;
  }

  async introspect(): Promise<DatabaseSchema> {
    const db = this.requireDb();
    const tableRows = db
      .prepare("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%' order by name")
      .all() as Array<{ name: string }>;

    const tables: TableInfo[] = tableRows.map((table) => {
      const columns = db.prepare(`pragma table_info(${JSON.stringify(table.name)})`).all() as Array<{
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

  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult {
    return validateSqliteReadOnlyQuery(query, mode);
  }

  async executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult> {
    const db = this.requireDb();
    const validation = this.validateQuery(query, mode);
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    const start = performance.now();
    const statement = db.prepare(validation.normalizedQuery);
    const rows = statement.reader
      ? statement.all() as Record<string, unknown>[]
      : [writeResultRow(statement.run())];
    const elapsedMs = Math.round(performance.now() - start);
    const columns = rows[0]
      ? Object.keys(rows[0])
      : this.getColumnsForEmptyResult(validation.normalizedQuery);

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

  private getColumnsForEmptyResult(query: string): string[] {
    try {
      return this.requireDb().prepare(query).columns().map((column) => column.name);
    } catch {
      return [];
    }
  }
}

function writeResultRow(result: Database.RunResult): Record<string, unknown> {
  return {
    changes: result.changes,
    lastInsertRowid: String(result.lastInsertRowid)
  };
}
