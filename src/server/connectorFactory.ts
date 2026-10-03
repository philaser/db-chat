import { boundResult, boundResultBytes } from './connectors/resultLimits.js';
import { classifyQuery } from './connectors/QueryValidator.js';
import type { ConnectionConfig, DatabaseConnector, DatabaseSchema, QueryResult, SafetyLevel } from '../shared/types.js';
import { ElasticsearchConnector } from './connectors/ElasticsearchConnector.js';
import { MongoDBConnector } from './connectors/MongoDBConnector.js';
import { MySQLConnector } from './connectors/MySQLConnector.js';
import { PostgresConnector } from './connectors/PostgresConnector.js';
import { SQLiteConnector } from './connectors/SQLiteConnector.js';

export function createConfiguredConnector(kind: ConnectionConfig['kind']): DatabaseConnector {
  switch (kind) {
    case 'elasticsearch': return new ElasticsearchConnector();
    case 'mongodb': return new MongoDBConnector();
    case 'mysql': return new MySQLConnector();
    case 'postgres': return new PostgresConnector();
    case 'sqlite': return new SQLiteConnector();
    default: throw new Error(`Unsupported web database kind: ${kind}`);
  }
}

export class WebPolicyConnector implements DatabaseConnector {
  constructor(
    private readonly inner: DatabaseConnector,
    private readonly maxRows: number,
    private readonly maxBytes: number
  ) {
    this.inner.setSafetyLevel('safe');
    this.inner.setResultLimit?.(maxRows);
  }

  connect(config: ConnectionConfig): Promise<void> {
    return this.inner.connect(config);
  }

  async introspect(): Promise<DatabaseSchema> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.inner.introspect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.inner.close();
            reject(new Error('Database schema discovery exceeded its 35-second deadline. Reduce the tables visible to this account.'));
          }, 35_000);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  setSafetyLevel(level: SafetyLevel): void {
    this.inner.setSafetyLevel('safe');
    if (level !== 'safe') {
      throw new Error('The web database policy is permanently read-only.');
    }
  }

  async executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult> {
    const result = await this.inner.executeQuery(query, options);
    const bounded = boundResult(result, this.maxRows);
    return boundResultBytes(bounded, this.maxBytes);
  }

  exportQuery(query: string, options?: { signal?: AbortSignal; batchSize?: number }): AsyncIterable<QueryResult> {
    if (classifyQuery(query) !== 'read') throw new Error('Exports require one explicit read-only query.');
    if (!this.inner.exportQuery) throw new Error('This database does not support streaming exports.');
    return this.inner.exportQuery(query, options);
  }

  getContextForPrompt(): Promise<string> {
    return this.inner.getContextForPrompt();
  }

  close(): void {
    this.inner.close();
  }
}
