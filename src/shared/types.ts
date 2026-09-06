export type DatabaseKind = 'sqlite' | 'elasticsearch' | 'mysql' | 'postgres' | 'mongodb';
export type ModelProviderKind = 'openrouter';
export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatActivityStatus = 'thinking' | 'validating' | 'running' | 'success' | 'blocked' | 'error' | 'complete';
export type SafetyLevel = 'safe' | 'standard' | 'elevated' | 'unrestricted';
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export interface ConnectionConfig {
  /** Server-only checked address; never accepted from request payloads or persisted. */
  resolvedAddress?: string;
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
  mongodbDirectConnection?: boolean;
  safetyLevel?: SafetyLevel;
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
  truncated?: boolean;
  rowLimit?: number;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export interface QueryResultArtifact {
  messageId?: string;
  kind: 'query-result';
  queryId: string;
  query: string;
  result: QueryResult;
  purpose?: string;
  schema?: DatabaseSchema;
}

export interface WebChatSummary {
  id: string;
  title: string;
  connectionId?: string;
  messageCount: number;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebChatSession extends WebChatSummary {
  messages: ChatMessage[];
  artifacts: QueryResultArtifact[];
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
  artifacts?: QueryResultArtifact[];
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
  setResultLimit?(maxRows: number): void;
  connect(config: ConnectionConfig): Promise<void>;
  introspect(): Promise<DatabaseSchema>;
  executeQuery(query: string, options?: { signal?: AbortSignal }): Promise<QueryResult>;
  getContextForPrompt(): Promise<string>;
  setSafetyLevel(level: SafetyLevel): void;
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
  | 'result'
  | 'complete'
  | 'error'
  | 'aborted'
  | 'approval-required'
  | 'approval-resolved';

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
  artifact?: QueryResult;
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

export interface AuditEntry {
  id: string;
  timestamp: string;
  turnId: string;
  connectionId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  permissionDecision: string;
  queryPreview?: string;
  risk?: string;
  elapsedMs?: number;
}
