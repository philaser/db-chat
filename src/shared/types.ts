export type DatabaseKind = 'sqlite' | 'elasticsearch' | 'mysql' | 'postgres' | 'mongodb';
export type ModelProviderKind = 'openrouter';
export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatActivityStatus = 'thinking' | 'validating' | 'running' | 'success' | 'blocked' | 'error' | 'complete';

export interface ConnectionConfig {
  id: string;
  kind: DatabaseKind;
  label: string;
  databasePath?: string;
  elasticsearchUrl?: string;
  elasticsearchHost?: string;
  elasticsearchPort?: number;
  elasticsearchUseSsl?: boolean;
  elasticsearchVerifyCerts?: boolean;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  elasticsearchRememberPassword?: boolean;
  elasticsearchHasSavedPassword?: boolean;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  rememberPassword?: boolean;
  hasSavedPassword?: boolean;
  authDatabase?: string;
  mongodbUri?: string;
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

export interface ChatActivityStep {
  id: string;
  queryId?: string;
  status: ChatActivityStatus;
  title: string;
  detail?: string;
  query?: string;
  rowCount?: number;
  elapsedMs?: number;
  createdAt: string;
}

export interface ChatTurnResponse {
  message: ChatMessage;
  events?: AgentEvent[];
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

export interface PersistedSettings {
  provider: ModelProviderKind;
  model: string;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ModelChatMessage {
  role: ChatRole | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
}

export interface ModelChatOptions {
  model: string;
  apiKey: string;
  temperature?: number;
  tools?: ModelTool[];
  toolChoice?: 'auto' | 'none';
  parallelToolCalls?: boolean;
}

export interface ModelTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
  };
}

export interface ModelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelProviderResponse {
  content: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelProvider {
  readonly kind: ModelProviderKind;
  readonly defaultModel: string;
  listModels(apiKey?: string): Promise<ModelInfo[]>;
  sendChat(messages: ModelChatMessage[], options: ModelChatOptions): Promise<string>;
  sendChatWithTools(messages: ModelChatMessage[], options: ModelChatOptions): Promise<ModelProviderResponse>;
}

export interface DatabaseConnector {
  connect(config: ConnectionConfig): Promise<void>;
  introspect(): Promise<DatabaseSchema>;
  executeQuery(query: string): Promise<QueryResult>;
  getContextForPrompt(): Promise<string>;
  close(): void;
}

// ----- Agent Harness Types -----

export type AgentState = 'idle' | 'thinking' | 'processing' | 'executing' | 'complete' | 'aborted';

export type AgentEventType =
  | 'text-delta'
  | 'tool-start'
  | 'tool-progress'
  | 'tool-complete'
  | 'thinking-start'
  | 'thinking-delta'
  | 'status'
  | 'complete'
  | 'error'
  | 'aborted';

export interface AgentEvent {
  turnId: string;
  type: AgentEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface AgentMemory {
  id: string;
  content: string;
  category: 'schema' | 'domain' | 'preference' | 'query' | 'note';
  importance: number;
  createdAt: string;
  lastAccessedAt: string;
}

export interface DbChatApi {
  chooseSqliteFile(): Promise<ConnectionConfig | null>;
  connect(config: ConnectionConfig): Promise<DatabaseSchema>;
  getSchema(): Promise<DatabaseSchema | null>;
  executeQuery(query: string): Promise<QueryResult>;
  sendChat(messages: ModelChatMessage[], turnId?: string): Promise<ChatTurnResponse>;
  subscribeToAgentEvents(turnId: string, listener: (event: AgentEvent) => void): () => void;
  abortChat(turnId: string): Promise<void>;
  loadSettings(): Promise<PersistedSettings & { hasApiKey: boolean }>;
  saveSettings(settings: PersistedSettings): Promise<void>;
  saveApiKey(provider: ModelProviderKind, apiKey: string): Promise<void>;
  listModels(provider: ModelProviderKind): Promise<ModelInfo[]>;
  listChatSessions(): Promise<PersistedChatSession[]>;
  saveChatSession(session: PersistedChatSession): Promise<PersistedChatSession>;
  deleteChatSession(id: string): Promise<void>;
  clearChatSessions(): Promise<void>;
  listConnections(): Promise<ConnectionHistoryItem[]>;
  deleteConnection(id: string): Promise<void>;
  saveCsvFile(request: { content: string; defaultName: string }): Promise<void>;
}
