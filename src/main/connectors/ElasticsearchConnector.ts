import type {
  ConnectionConfig,
  DatabaseConnector,
  DatabaseSchema,
  QueryExecutionMode,
  QueryResult,
  QueryValidationResult
} from '../../shared/types.js';

export class ElasticsearchConnector implements DatabaseConnector {
  async connect(_config: ConnectionConfig): Promise<void> {
    throw new Error('Elasticsearch support is planned for the next milestone.');
  }

  async introspect(): Promise<DatabaseSchema> {
    throw new Error('Elasticsearch support is planned for the next milestone.');
  }

  validateQuery(_query: string, _mode: QueryExecutionMode): QueryValidationResult {
    return {
      safe: false,
      reason: 'Elasticsearch execution is not implemented in this MVP.',
      normalizedQuery: ''
    };
  }

  async executeQuery(_query: string): Promise<QueryResult> {
    throw new Error('Elasticsearch support is planned for the next milestone.');
  }

  async getContextForPrompt(): Promise<string> {
    throw new Error('Elasticsearch support is planned for the next milestone.');
  }

  close(): void {}
}
