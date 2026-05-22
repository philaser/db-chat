export type DatabaseKind = 'sqlite' | 'elasticsearch' | 'mysql' | 'postgres';
export type ModelProviderKind = 'openrouter' | 'openai';
export type QueryExecutionMode = 'safe' | 'manual';
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ConnectionConfig {
  id: string;
  kind: DatabaseKind;
  label: string;
  databasePath?: string;
  /** Kept for existing saved Elasticsearch connections created with URL input. */
  elasticsearchUrl?: string;
  elasticsearchHost?: string;
  elasticsearchPort?: number;
  elasticsearchUseSsl?: boolean;
  elasticsearchVerifyCerts?: boolean;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  elasticsearchRememberPassword?: boolean;
  elasticsearchHasSavedPassword?: boolean;
  createdAt: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

export interface DatabaseSchema {
  kind: DatabaseKind;
  label: string;
  tables: TableInfo[];
}

export interface QueryValidationResult {
  safe: boolean;
  reason: string;
  normalizedQuery: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface GeneratedQuery {
  query: string;
  explanation: string;
  validation: QueryValidationResult;
}

export interface ChatTurnResponse {
  message: ChatMessage;
  generatedQuery?: GeneratedQuery;
  queryResult?: QueryResult;
}

export interface ConnectionHistoryItem extends ConnectionConfig {
  lastConnectedAt: string;
}

export interface PersistedChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  connection?: ConnectionConfig;
  query?: string;
  result?: QueryResult;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderSettings {
  provider: ModelProviderKind;
  model: string;
  hasApiKey: boolean;
}

export interface PersistedSettings {
  provider: ModelProviderKind;
  model: string;
  safeMode: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ModelChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelChatOptions {
  model: string;
  apiKey: string;
  temperature?: number;
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  readonly defaultModel: string;
  listModels(apiKey?: string): Promise<ModelInfo[]>;
  sendChat(messages: ModelChatMessage[], options: ModelChatOptions): Promise<string>;
}

export interface DatabaseConnector {
  connect(config: ConnectionConfig): Promise<void>;
  introspect(): Promise<DatabaseSchema>;
  validateQuery(query: string, mode: QueryExecutionMode): QueryValidationResult;
  executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult>;
  getContextForPrompt(): Promise<string>;
  close(): void;
}

export interface DbChatApi {
  chooseSqliteFile(): Promise<ConnectionConfig | null>;
  connect(config: ConnectionConfig): Promise<DatabaseSchema>;
  getSchema(): Promise<DatabaseSchema | null>;
  validateQuery(query: string, mode: QueryExecutionMode): Promise<QueryValidationResult>;
  executeQuery(query: string, mode: QueryExecutionMode): Promise<QueryResult>;
  sendChat(messages: ModelChatMessage[]): Promise<ChatTurnResponse>;
  loadSettings(): Promise<PersistedSettings & { hasApiKey: boolean }>;
  saveSettings(settings: PersistedSettings): Promise<void>;
  saveApiKey(provider: ModelProviderKind, apiKey: string): Promise<void>;
  listModels(provider: ModelProviderKind): Promise<ModelInfo[]>;
  listChatSessions(): Promise<PersistedChatSession[]>;
  saveChatSession(session: PersistedChatSession): Promise<PersistedChatSession>;
  deleteChatSession(id: string): Promise<void>;
  listConnections(): Promise<ConnectionHistoryItem[]>;
  deleteConnection(id: string): Promise<void>;
}
