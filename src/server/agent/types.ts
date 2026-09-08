import type { EffortLevel, DatabaseConnector, DatabaseSchema, AgentMemory, AgentEvent, AgentToolDefinition, AgentToolResult, ModelChatMessage, QueryResultArtifact } from '../../shared/types.js';
import type { MemoryStore } from './MemoryStore.js';

export interface AgentModelClient {
  streamChat(options: {
    model: string;
    effortLevel?: EffortLevel;
    messages: ModelChatMessage[];
    tools?: AgentToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<{
    content?: string;
    reasoning?: string;
    toolCalls?: Array<{
      index: number;
      id?: string;
      type?: 'function';
      function?: { name?: string; arguments?: string };
    }>;
    finishReason?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  }>;
}

export interface AgentController {
  getConnector(): DatabaseConnector | null;
  getSchema(): DatabaseSchema | null | Promise<DatabaseSchema | null>;
  refreshSchema(): Promise<DatabaseSchema | null>;
  getMemoryStore(): MemoryStore;
  getConnectionId(): string;
  audit(entry: {
    turnId: string;
    connectionId: string;
    toolName: string;
    toolInput?: Record<string, unknown>;
    permissionDecision: string;
    queryPreview?: string;
    risk?: string;
    elapsedMs?: number;
  }): void;
}

export interface ToolContext {
  signal?: AbortSignal;
  turnId: string;
  controller: AgentController;
  connector: DatabaseConnector | null;
  schema: DatabaseSchema | null;
  /** Resolve only artifacts already authorized for this turn. */
  resolveArtifact?: (resultId: string) => QueryResultArtifact | undefined;
  /** Allocate a stable ID before a query result is returned to the model. */
  allocateResultId?: () => string;
  /** Start a server-owned export without placing the exported rows in model context. */
  requestExport?: (request: {
    resultId?: string;
    query?: string;
    format: 'csv' | 'xlsx' | 'json';
    title: string;
  }) => Promise<{ id: string; format: 'csv' | 'xlsx' | 'json'; title: string; status: string }>;
  /** Render validated report blocks into a downloadable server-owned artifact. */
  requestReport?: (request: {
    title: string;
    blocks: Record<string, unknown>[];
    resultIds: string[];
    format: 'html' | 'markdown';
  }) => Promise<{ id: string; format: 'html' | 'markdown'; title: string; status: string }>;
  emitEvent: (event: AgentEvent) => void;
}

export interface Tool {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<AgentToolResult>;
}

export interface ContextSnapshot {
  messages: ModelChatMessage[];
  memories: AgentMemory[];
  schemaContext: string;
  estimatedTokens: number;
}

export interface CompactConfig {
  highWaterMark: number;
  criticalMark: number;
  maxMessages: number;
  keepRecent: number;
}

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  highWaterMark: 0.75,
  criticalMark: 0.90,
  maxMessages: 50,
  keepRecent: 8
};

export const AGENT_DEFAULTS = {
  maxTurnRounds: 10,
  maxParallelTools: 5,
  maxTotalToolCalls: 20,
  modelCallTimeoutMs: 120_000,
  totalTimeoutMs: 300_000,
  temperature: 0.2,
  maxTokens: 4096
} as const;
