import type { DatabaseConnector, DatabaseSchema, AgentMemory, AgentEvent, AgentToolDefinition, AgentToolResult, ModelChatMessage, QueryResult } from '../../shared/types.js';

export interface ToolContext {
  turnId: string;
  controller: import('../ipc.js').IpcController;
  connector: DatabaseConnector | null;
  schema: DatabaseSchema | null;
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
