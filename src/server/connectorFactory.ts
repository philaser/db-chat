import { boundResult } from './connectors/resultLimits.js';
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

  introspect(): Promise<DatabaseSchema> {
    return this.inner.introspect();
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
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > this.maxBytes) {
      throw new Error('The query result is too large for the web chat. Narrow the query and try again.');
    }
    return bounded;
  }

  getContextForPrompt(): Promise<string> {
    return this.inner.getContextForPrompt();
  }

  close(): void {
    this.inner.close();
  }
}
