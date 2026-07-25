# Agent Harness Implementation Plan

> **Status:** Approved design — ready for implementation.
> **Dependencies:** `@openrouter/sdk` (npm install required)
> **Removes:** SAFE mode, all validation modules, `runToolQueryLoop`, `extractQueryBlock`, `buildLocalAssistantResponse`
> **Builds:** Complete new agent harness in `src/main/agent/`

---

## Architecture Overview

```
src/main/agent/
├── AgentLoop.ts              # Core state machine
├── ToolRegistry.ts           # Tool registration & execution
├── ContextManager.ts         # Auto-compaction & token estimation
├── MemoryStore.ts            # Persistent memory (schema facts, preferences)
├── ActivityManager.ts        # Structured streaming events to renderer
├── types.ts                  # Agent-specific types
│
├── tools/
│   ├── index.ts              # Register all tools
│   ├── RunDatabaseQueryTool.ts
│   ├── GetSchemaInfoTool.ts
│   ├── SampleDataTool.ts
│   └── SaveMemoryTool.ts
│
├── prompts/
│   ├── system.ts             # Dynamic system prompt builder
│   ├── compaction.ts         # Summarization prompt
│   └── memory-extraction.ts  # Memory extraction prompt
│
└── __tests__/
    ├── AgentLoop.test.ts
    ├── ToolRegistry.test.ts
    ├── ContextManager.test.ts
    └── tools/

src/main/model/
├── OpenRouterClient.ts       # @openrouter/sdk wrapper
└── apiKeys.ts                # Simplified — remove normalizeApiKey

src/main/ipc.ts               # Simplified — delegate to AgentLoop
src/main/main.ts              # Minimal changes — new IPC handler
src/preload/preload.cts       # New event channel subscriptions
src/shared/types.ts           # Remove SAFE mode, add agent types
src/renderer/App.tsx          # Streaming event handlers, abort UI
src/renderer/styles.css       # Streaming & activity styles
test/App.test.tsx             # Updated for new event model
```

---

## Task 1: Install OpenRouter SDK & Remove Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `@openrouter/sdk`**

```bash
npm install @openrouter/sdk
```

Expected: package.json updated with dependency.

- [ ] **Step 2: Remove unused dependencies**

No packages to remove. `better-sqlite3`, `mysql2`, `pg`, `mongodb` drivers remain.

- [ ] **Step 3: Verify install**

```bash
npx tsc --noEmit
```

Expected: Should pass. The new package won't cause issues until we import it.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @openrouter/sdk"
```

---

## Task 2: Rewrite `src/shared/types.ts` — Remove SAFE Mode, Add Agent Types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Remove SAFE-mode types**

Delete these types entirely:
- `QueryExecutionMode` (lines 5-7 area)
- `QueryValidationResult` (lines 53-57 area)

- [ ] **Step 2: Remove `generatedQuery`, `queryResult` from legacy types; add agent types**

Replace the relevant sections. Remove `GeneratedQuery` type and update `ChatTurnResponse`. Add new agent types:

```typescript
// ----- Agent Loop Types -----

type AgentState = 'idle' | 'thinking' | 'processing' | 'executing' | 'complete' | 'aborted';

type AgentEventType =
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

interface AgentEvent {
  turnId: string;
  type: AgentEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ----- Tool Types -----

interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface AgentToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  error?: string;
}

// ----- Memory Types -----

interface AgentMemory {
  id: string;
  content: string;
  category: 'schema' | 'domain' | 'preference' | 'query' | 'note';
  importance: number;
  createdAt: string;
  lastAccessedAt: string;
}

// ----- Updated Chat Types -----

interface ChatTurnRequest {
  messages: ModelChatMessage[];
  turnId: string;
  schemaContext?: string;
  memories?: AgentMemory[];
}

interface ChatTurnResponse {
  message: ChatMessage;
  toolCalls?: Array<{ query: string; purpose: string; result: AgentToolResult }>;
  events: AgentEvent[];
}

// ----- Updated API -----

interface DbChatApi {
  // ... existing methods preserved ...
  sendChat(messages: ModelChatMessage[], turnId?: string): Promise<ChatTurnResponse>;
  subscribeToAgentEvents(
    turnId: string,
    listener: (event: AgentEvent) => void
  ): () => void;
  abortChat(turnId: string): void;
  // ... rest preserved ...
}
```

- [ ] **Step 3: Remove `QueryExecutionMode` from all type references**

Update `DatabaseConnector` to remove `mode` parameter:
```typescript
interface DatabaseConnector {
  connect(config: ConnectionConfig): Promise<void>;
  introspect(): Promise<DatabaseSchema>;
  executeQuery(query: string): Promise<QueryResult>;
  getContextForPrompt(): Promise<string>;
  close(): void;
}
```
Remove `validateQuery` entirely — no validation needed without SAFE mode.

- [ ] **Step 4: Verify TypeScript**

```bash
npx tsc --noEmit
```
Expected: Errors everywhere referencing removed types. This is expected — we'll fix them as we go.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts
git commit -m "refactor(types): remove SAFE-mode types, add agent harness types"
```

---

## Task 3: Build `src/main/agent/types.ts`

**Files:**
- Create: `src/main/agent/types.ts`

```typescript
import type { AgentMemory, AgentEvent, AgentToolDefinition, AgentToolResult, ModelChatMessage, QueryResult } from '../../shared/types';

export interface ToolContext {
  turnId: string;
  controller: IpcController;
  connector: import('../connectors').DatabaseConnector | null;
  schema: import('../../shared/types').DatabaseSchema | null;
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
  highWaterMark: number;   // 0.75
  criticalMark: number;     // 0.90
  maxMessages: number;      // 50
  keepRecent: number;       // 8 (messages to keep intact)
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
```

- [ ] **Commit**

```bash
git add src/main/agent/
git commit -m "feat(agent): add agent harness types and defaults"
```

---

## Task 4: Build `src/main/model/OpenRouterClient.ts`

**Files:**
- Create: `src/main/model/OpenRouterClient.ts`
- Modify: `src/main/model/providers.ts` (remove old providers)

This is the single-model wrapper around `@openrouter/sdk`. It provides streaming,
tool calling, and model listing.

```typescript
import { OpenRouter } from '@openrouter/sdk';
import type { ModelInfo } from '../../shared/types';

export interface OpenRouterConfig {
  apiKey: string;
}

export interface ChatOptions {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  temperature?: number;
  maxTokens?: number;
}

export class OpenRouterClient {
  private client: OpenRouter;

  constructor(config: OpenRouterConfig) {
    this.client = new OpenRouter({
      apiKey: config.apiKey,
      httpReferer: 'https://github.com/philaser/db-chat',
      appTitle: 'DB Chat'
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      return response.data.map((model) => ({
        id: model.id,
        name: model.name ?? model.id
      }));
    } catch {
      return [
        { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
      ];
    }
  }

  async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
    try {
      const stream = await this.client.chat.stream({
        model: options.model,
        messages: options.messages as Array<{ role: string; content: string }>,
        tools: options.tools,
        temperature: options.temperature,
        max_tokens: options.maxTokens
      });

      for await (const chunk of stream) {
        yield this.parseChunk(chunk);
      }
    } catch (error) {
      throw new Error(`OpenRouter stream error: ${(error as Error).message}`);
    }
  }

  private parseChunk(chunk: Record<string, unknown>): StreamChunk {
    const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0] ?? {};
    const delta = choice.delta as Record<string, unknown> | undefined;

    return {
      content: delta?.content as string | undefined,
      reasoning: delta?.reasoning_content as string | undefined,
      toolCalls: delta?.tool_calls as ToolCallDelta[] | undefined,
      finishReason: choice.finish_reason as string | undefined
    };
  }
}

export interface StreamChunk {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}
```

- [ ] **Remove old providers.ts content**

Replace `src/main/model/providers.ts` with:

```typescript
import { OpenRouterClient } from './OpenRouterClient';
import { normalizeApiKey } from './apiKeys';

export { OpenRouterClient, normalizeApiKey };
```

- [ ] **Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: Errors in ipc.ts (references old providers). We'll fix those in later tasks.

- [ ] **Commit**

```bash
git add src/main/model/
git commit -m "feat(model): add OpenRouterClient with streaming support"
```

---

## Task 5: Build `src/main/agent/ToolRegistry.ts`

**Files:**
- Create: `src/main/agent/ToolRegistry.ts`

```typescript
import type { Tool, ToolContext } from './types';
import type { AgentToolDefinition, AgentToolResult } from '../../shared/types';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.function.name)) {
      throw new Error(`Tool already registered: ${tool.definition.function.name}`);
    }
    this.tools.set(tool.definition.function.name, tool);
  }

  getOpenAiTools(): AgentToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  getSystemPromptSection(): string {
    if (this.tools.size === 0) return '';
    const toolList = Array.from(this.tools.values())
      .map((tool) => `- ${tool.definition.function.name}: ${tool.definition.function.description}`)
      .join('\n');
    return `\n## Available Tools\n\n${toolList}\n\nUse tools when you need to access the database.`;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<AgentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, summary: `Unknown tool: ${name}`, error: `Tool "${name}" not found` };
    }
    try {
      return await tool.execute(input, context);
    } catch (error) {
      return {
        ok: false,
        summary: `Tool "${name}" failed`,
        error: (error as Error).message
      };
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get count(): number {
    return this.tools.size;
  }
}
```

- [ ] **Commit**

```bash
git add src/main/agent/ToolRegistry.ts
git commit -m "feat(agent): add ToolRegistry for pluggable tools"
```

---

## Task 6: Build Agent Tools

**Files:**
- Create: `src/main/agent/tools/RunDatabaseQueryTool.ts`
- Create: `src/main/agent/tools/GetSchemaInfoTool.ts`
- Create: `src/main/agent/tools/SampleDataTool.ts`
- Create: `src/main/agent/tools/SaveMemoryTool.ts`
- Create: `src/main/agent/tools/index.ts`

Create each tool file with this structure:

### RunDatabaseQueryTool

```typescript
import type { Tool } from '../types';

export const runDatabaseQueryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Execute a read-only database query against the connected database. Use this whenever you need to retrieve data.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The exact SQL query or JSON request string for the database connector.'
          },
          purpose: {
            type: 'string',
            description: 'A brief, user-visible description of what this query does.'
          }
        },
        required: ['query', 'purpose'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { query, purpose } = input as { query: string; purpose: string };
    if (!context.connector) {
      return { ok: false, summary: 'No database connected', error: 'No active database connection' };
    }
    const startTime = Date.now();
    try {
      const result = await context.connector.executeQuery(query);
      const elapsedMs = Date.now() - startTime;
      const preview = result.rows.slice(0, 10);
      return {
        ok: true,
        summary: `Query returned ${result.rowCount} row(s) in ${elapsedMs}ms`,
        data: {
          columns: result.columns.map((c) => c.name),
          rowCount: result.rowCount,
          elapsedMs,
          preview,
          totalRows: result.rowCount,
          hasMore: result.rows.length > 10
        }
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Query failed: ${(error as Error).message}`,
        error: (error as Error).message
      };
    }
  }
};
```

### GetSchemaInfoTool

```typescript
import type { Tool } from '../types';

export const getSchemaInfoTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_schema_info',
      description: 'Get information about the database schema — tables, columns, types, and primary keys.',
      parameters: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'Optional: get detailed info for a specific table. Omit to list all tables.'
          }
        },
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName } = input as { tableName?: string };
    if (!context.schema) {
      return { ok: false, summary: 'No schema available', error: 'No database schema loaded' };
    }

    if (tableName) {
      const table = context.schema.tables.find(
        (t) => t.name.toLowerCase() === tableName.toLowerCase()
      );
      if (!table) {
        return { ok: false, summary: `Table "${tableName}" not found`, error: 'Table not found' };
      }
      return {
        ok: true,
        summary: `Schema for table "${table.name}" (${table.columns.length} columns)`,
        data: {
          table: {
            name: table.name,
            columns: table.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              primaryKey: c.primaryKey
            }))
          }
        }
      };
    }

    return {
      ok: true,
      summary: `Database has ${context.schema.tables.length} table(s)`,
      data: {
        tables: context.schema.tables.map((t) => ({
          name: t.name,
          columnCount: t.columns.length,
          columns: t.columns.map((c) => c.name)
        }))
      }
    };
  }
};
```

### SampleDataTool

```typescript
import type { Tool } from '../types';

export const sampleDataTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'sample_data',
      description: 'Get a small sample of rows from a table to understand its data.',
      parameters: {
        type: 'object',
        properties: {
          tableName: {
            type: 'string',
            description: 'The name of the table to sample from.'
          },
          limit: {
            type: 'number',
            description: 'Number of rows to return (default: 5, max: 25).'
          }
        },
        required: ['tableName'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { tableName, limit = 5 } = input as { tableName: string; limit?: number };
    if (!context.connector) {
      return { ok: false, summary: 'No database connected' };
    }
    const safeLimit = Math.min(Math.max(1, limit), 25);

    try {
      const result = await context.connector.executeQuery(
        `SELECT * FROM "${tableName}" LIMIT ${safeLimit}`
      );
      return {
        ok: true,
        summary: `${result.rowCount} row(s) from "${tableName}"`,
        data: {
          columns: result.columns.map((c) => c.name),
          rows: result.rows.slice(0, safeLimit),
          rowCount: result.rowCount
        }
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Failed to sample "${tableName}"`,
        error: (error as Error).message
      };
    }
  }
};
```

### SaveMemoryTool

```typescript
import type { Tool } from '../types';

export const saveMemoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Store a useful fact or user preference in persistent memory for future conversations.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The fact, preference, or insight to remember.'
          },
          category: {
            type: 'string',
            description: 'Category: schema, domain, preference, query, or note.'
          },
          importance: {
            type: 'number',
            description: 'Importance level from 1 (low) to 10 (high).'
          }
        },
        required: ['content', 'category', 'importance'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { content, category, importance } = input as {
      content: string;
      category: string;
      importance: number;
    };
    const validCategories = ['schema', 'domain', 'preference', 'query', 'note'];
    if (!validCategories.includes(category)) {
      return { ok: false, summary: `Invalid category: ${category}`, error: 'Invalid category' };
    }
    return {
      ok: true,
      summary: `Memory saved: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`,
      data: { content, category, importance }
    };
  }
};
```

### tools/index.ts

```typescript
import { runDatabaseQueryTool } from './RunDatabaseQueryTool';
import { getSchemaInfoTool } from './GetSchemaInfoTool';
import { sampleDataTool } from './SampleDataTool';
import { saveMemoryTool } from './SaveMemoryTool';
import { ToolRegistry } from '../ToolRegistry';
import type { Tool } from '../types';

export const allTools: Tool[] = [
  runDatabaseQueryTool,
  getSchemaInfoTool,
  sampleDataTool,
  saveMemoryTool
];

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of allTools) {
    registry.register(tool);
  }
  return registry;
}

export { runDatabaseQueryTool, getSchemaInfoTool, sampleDataTool, saveMemoryTool };
```

- [ ] **Commit**

```bash
git add src/main/agent/tools/
git commit -m "feat(agent): add pluggable agent tools"
```

---

## Task 7: Build `src/main/agent/prompts/system.ts`

**Files:**
- Create: `src/main/agent/prompts/system.ts`

```typescript
import type { AgentMemory } from '../../../shared/types';

export function buildSystemPrompt(options: {
  schemaContext: string;
  schemaKind: string;
  memories: AgentMemory[];
  toolsSection: string;
}): string {
  const { schemaContext, schemaKind, memories, toolsSection } = options;

  const sections = [
    `You are DB Chat, an expert data analyst with direct access to the user's connected ${schemaKind} database.`,

    `Your goal is to help the user understand their data. Be warm, concise, and curious. When analyzing data, explain your reasoning clearly and highlight what the numbers mean — not just what they are.`,

    schemaContext
      ? `\n## Connected Database\n\n${schemaContext}`
      : '\n## Connected Database\n\nNo database is connected. Ask the user to connect one.',

    `\n## Response Style\n\n- Start with the key takeaway, then provide supporting details.\n- Do light arithmetic when helpful.\n- Suggest follow-up questions the user might ask next.\n- When showing query results, explain what the data reveals.\n- Do not include raw SQL or JSON in your answer unless the user explicitly asks for it.\n- Use the available tools to browse the schema and run queries.`,

    toolsSection,

    memories.length > 0
      ? `\n## What You Know About This Database\n\n${memories
          .sort((a, b) => b.importance - a.importance)
          .map((m) => `- [${m.category}] ${m.content}`)
          .join('\n')}`
      : '',

    `\n## Query Guidelines\n\n- Always use the run_database_query tool for every data access.\n- Use get_schema_info when you need to understand the database structure.\n- Use sample_data to peek at table contents before writing complex queries.\n- Run queries one at a time. Think about what would be most helpful to show next.`
  ];

  return sections.filter(Boolean).join('\n');
}

export function buildCompactionPrompt(): string {
  return `Summarize the conversation so far, preserving:\n1. Key facts the user has shared about their data.\n2. Important results and insights from queries.\n3. The user's stated goals and questions.\n4. Any preferences or context the user has mentioned.\n\nBe concise. Focus on what matters for continuing the data analysis.`;
}

export function buildMemoryExtractionPrompt(): string {
  return `Extract 2-5 important facts from this conversation that would be useful to remember for future data analysis sessions. Focus on:\n- Schema details the user has mentioned\n- Domain knowledge about the data\n- User preferences (e.g., preferred format, common queries)\n- Insights the user found valuable\n\nReturn as a JSON array of objects with fields: content, category (schema/domain/preference/query/note), importance (1-10).`;
}
```

- [ ] **Commit**

```bash
git add src/main/agent/prompts/
git commit -m "feat(agent): add dynamic system prompt builder"
```

---

## Task 8: Build `src/main/agent/ActivityManager.ts`

**Files:**
- Create: `src/main/agent/ActivityManager.ts`

```typescript
import type { WebContents } from 'electron';
import type { AgentEvent } from '../../shared/types';

export class ActivityManager {
  private events: AgentEvent[] = [];

  constructor(
    private turnId: string,
    private webContents?: WebContents
  ) {}

  emit(type: AgentEvent['type'], data?: Record<string, unknown>): void {
    const event: AgentEvent = {
      turnId: this.turnId,
      type,
      timestamp: new Date().toISOString(),
      data: data ?? {}
    };

    this.events.push(event);

    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(`dbchat:agent-event:${this.turnId}`, event);
    }
  }

  textDelta(delta: string): void {
    this.emit('text-delta', { delta });
  }

  toolStart(toolName: string, purpose?: string): void {
    this.emit('tool-start', { toolName, purpose });
  }

  toolComplete(toolName: string, summary: string): void {
    this.emit('tool-complete', { toolName, summary });
  }

  thinkingDelta(delta: string): void {
    this.emit('thinking-delta', { delta });
  }

  status(message: string): void {
    this.emit('status', { message });
  }

  complete(message: Record<string, unknown>): void {
    this.emit('complete', { message });
  }

  error(message: string): void {
    this.emit('error', { message });
  }

  aborted(): void {
    this.emit('aborted');
  }

  getEvents(): AgentEvent[] {
    return [...this.events];
  }
}
```

- [ ] **Commit**

```bash
git add src/main/agent/ActivityManager.ts
git commit -m "feat(agent): add ActivityManager for structured event streaming"
```

---

## Task 9: Build `src/main/agent/ContextManager.ts`

**Files:**
- Create: `src/main/agent/ContextManager.ts`

```typescript
import type { ModelChatMessage, AgentMemory } from '../../shared/types';
import { DEFAULT_COMPACT_CONFIG, type CompactConfig, type ContextSnapshot } from './types';
import type { OpenRouterClient } from '../model/OpenRouterClient';
import { buildCompactionPrompt } from './prompts/system';

export class ContextManager {
  constructor(
    private client: OpenRouterClient,
    private model: string,
    private config: CompactConfig = DEFAULT_COMPACT_CONFIG
  ) {}

  estimateTokens(messages: ModelChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4; // message overhead
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 3.5);
      }
      if (msg.tool_calls) {
        total += JSON.stringify(msg.tool_calls).length / 3;
      }
    }
    return Math.ceil(total);
  }

  async compact(
    messages: ModelChatMessage[],
    memories: AgentMemory[],
    schemaContext: string,
    modelContextLimit: number
  ): Promise<ContextSnapshot> {
    const tokenCount = this.estimateTokens(messages);
    const watermark = Math.floor(modelContextLimit * this.config.highWaterMark);

    if (tokenCount <= watermark) {
      return { messages, memories, schemaContext, estimatedTokens: tokenCount };
    }

    const keepCount = this.config.keepRecent;
    const toCompact = messages.slice(0, -keepCount);
    const recent = messages.slice(-keepCount);

    if (toCompact.length === 0) {
      return { messages, memories, schemaContext, estimatedTokens: tokenCount };
    }

    const compactionMessages: ModelChatMessage[] = [
      { role: 'system', content: buildCompactionPrompt() },
      ...toCompact.filter((m) => m.role === 'user' || m.role === 'assistant')
    ];

    try {
      const client = this.client;
      let summary = '';
      const stream = client.streamChat({
        model: this.model,
        messages: compactionMessages,
        temperature: 0.1,
        maxTokens: 1024
      });

      for await (const chunk of stream) {
        if (chunk.content) summary += chunk.content;
      }

      const compactedMessage: ModelChatMessage = {
        role: 'system',
        content: `[Conversation summary from earlier: ${summary}]`
      };

      const compacted = [compactedMessage, ...recent];
      return {
        messages: compacted,
        memories,
        schemaContext,
        estimatedTokens: this.estimateTokens(compacted)
      };
    } catch {
      return { messages, memories, schemaContext, estimatedTokens: tokenCount };
    }
  }

  shouldCompact(tokenCount: number, modelContextLimit: number): boolean {
    return tokenCount > modelContextLimit * this.config.highWaterMark;
  }
}
```

- [ ] **Commit**

```bash
git add src/main/agent/ContextManager.ts
git commit -m "feat(agent): add ContextManager with auto-compaction"
```

---

## Task 10: Build `src/main/agent/MemoryStore.ts`

**Files:**
- Create: `src/main/agent/MemoryStore.ts`

```typescript
import type { AgentMemory } from '../../shared/types';

export class MemoryStore {
  private memories: AgentMemory[] = [];

  add(content: string, category: AgentMemory['category'], importance: number): AgentMemory {
    const memory: AgentMemory = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      category,
      importance: Math.max(1, Math.min(10, importance)),
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString()
    };
    this.memories.push(memory);
    this.prune();
    return memory;
  }

  search(query: string): AgentMemory[] {
    const lower = query.toLowerCase();
    return this.memories
      .filter((m) => m.content.toLowerCase().includes(lower))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);
  }

  getRelevant(maxCount: number = 10): AgentMemory[] {
    return [...this.memories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, maxCount);
  }

  getAll(): AgentMemory[] {
    return [...this.memories];
  }

  delete(id: string): boolean {
    const index = this.memories.findIndex((m) => m.id === id);
    if (index >= 0) {
      this.memories.splice(index, 1);
      return true;
    }
    return false;
  }

  clear(): void {
    this.memories = [];
  }

  private prune(): void {
    if (this.memories.length > 100) {
      this.memories.sort((a, b) => b.importance - a.importance);
      this.memories = this.memories.slice(0, 100);
    }
  }

  toJSON(): AgentMemory[] {
    return this.memories;
  }

  fromJSON(data: AgentMemory[]): void {
    this.memories = data;
  }
}
```

- [ ] **Commit**

```bash
git add src/main/agent/MemoryStore.ts
git commit -m "feat(agent): add MemoryStore for persistent facts"
```

---

## Task 11: Build `src/main/agent/AgentLoop.ts` — The Core

**Files:**
- Create: `src/main/agent/AgentLoop.ts`

This is the main orchestrator. It replaced `runToolQueryLoop()` and the single-round fallback in `sendChat()`.

```typescript
import type { WebContents } from 'electron';
import type { ChatMessage, ModelChatMessage, AgentEvent, AgentMemory, QueryResult } from '../../shared/types';
import { ToolRegistry } from './ToolRegistry';
import { ActivityManager } from './ActivityManager';
import { ContextManager } from './ContextManager';
import { MemoryStore } from './MemoryStore';
import { OpenRouterClient, type StreamChunk } from '../model/OpenRouterClient';
import { buildSystemPrompt } from './prompts/system';
import { AGENT_DEFAULTS, type ToolContext } from './types';
import type { IpcController } from '../ipc';

export interface AgentLoopConfig {
  model: string;
  client: OpenRouterClient;
  controller: IpcController;
  memoryStore: MemoryStore;
  toolRegistry: ToolRegistry;
}

interface TurnResult {
  message: ChatMessage;
  events: AgentEvent[];
  toolCalls: Array<{ query: string; purpose: string; result: unknown }>;
}

export async function runAgentLoop(
  messages: ModelChatMessage[],
  turnId: string,
  webContents: WebContents | undefined,
  config: AgentLoopConfig
): Promise<TurnResult> {
  const activity = new ActivityManager(turnId, webContents);
  const context = new ContextManager(config.client, config.model);
  const abortController = new AbortController();

  const toolContext: ToolContext = {
    turnId,
    controller: config.controller,
    connector: config.controller.getConnector(),
    schema: await config.controller.getSchema(),
    emitEvent: (event) => activity.emit(event.type, event.data)
  };

  const schemaContext = config.controller.getConnector()
    ? await config.controller.getConnector()!.getContextForPrompt()
    : 'No database connected.';

  const schemaKind = (await config.controller.getSchema())?.kind ?? 'sqlite';
  const memories = config.memoryStore.getRelevant(10);

  const tools = config.toolRegistry.getOpenAiTools();
  const toolsSection = config.toolRegistry.getSystemPromptSection();

  let conversation: ModelChatMessage[] = [];

  const systemPrompt = buildSystemPrompt({
    schemaContext,
    schemaKind,
    memories,
    toolsSection
  });
  conversation.push({ role: 'system', content: systemPrompt });

  conversation.push(...messages.filter((m) => m.role === 'user' || m.role === 'assistant'));

  activity.status('Thinking...');

  let totalToolCalls = 0;
  const allToolCalls: Array<{ query: string; purpose: string; result: unknown }> = [];

  try {
    for (let round = 0; round < AGENT_DEFAULTS.maxTurnRounds; round++) {
      if (abortController.signal.aborted) {
        activity.aborted();
        return buildResult(activity, allToolCalls, 'Analysis was cancelled.');
      }

      const snapshot = await context.compact(
        conversation,
        memories,
        schemaContext,
        128000
      );
      conversation = snapshot.messages;

      activity.status(round === 0 ? 'Analyzing...' : 'Continuing analysis...');

      const modelResponse = await streamModelResponse(
        config.client,
        config.model,
        snapshot.messages,
        tools,
        activity,
        abortController.signal
      );

      if (modelResponse.aborted) {
        activity.aborted();
        return buildResult(activity, allToolCalls, 'Analysis was cancelled.');
      }

      if (modelResponse.toolCalls.length === 0) {
        activity.complete({ content: modelResponse.content });
        return buildResult(activity, allToolCalls, modelResponse.content);
      }

      const assistantMessage: ModelChatMessage = {
        role: 'assistant',
        content: modelResponse.content || null,
        tool_calls: modelResponse.toolCalls
      };
      conversation.push(assistantMessage);

      const pendingCalls = modelResponse.toolCalls.slice(0, AGENT_DEFAULTS.maxParallelTools);
      if (totalToolCalls + pendingCalls.length > AGENT_DEFAULTS.maxTotalToolCalls) {
        pendingCalls.splice(AGENT_DEFAULTS.maxTotalToolCalls - totalToolCalls);
      }

      for (const call of pendingCalls) {
        const toolName = call.function.name;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = {};
        }

        activity.toolStart(toolName, input.purpose as string);

        const result = await config.toolRegistry.execute(toolName, input, toolContext);
        totalToolCalls++;

        const toolMessage: ModelChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result)
        };
        conversation.push(toolMessage);

        activity.toolComplete(toolName, result.summary);

        allToolCalls.push({
          query: (input.query as string) ?? JSON.stringify(input),
          purpose: (input.purpose as string) ?? toolName,
          result
        });
      }
    }

    activity.status('Wrapping up analysis...');
    return buildResult(activity, allToolCalls, 'Analysis complete.');
  } catch (error) {
    activity.error((error as Error).message);
    return buildResult(activity, allToolCalls, `An error occurred: ${(error as Error).message}`);
  }
}

async function streamModelResponse(
  client: OpenRouterClient,
  model: string,
  messages: ModelChatMessage[],
  tools: ReturnType<ToolRegistry['getOpenAiTools']>,
  activity: ActivityManager,
  signal: AbortSignal
): Promise<{ content: string; toolCalls: ToolCallAccumulator[]; aborted: boolean }> {
  let content = '';
  let reasoning = '';
  const toolCallMap = new Map<number, ToolCallAccumulator>();

  try {
    const stream = client.streamChat({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: AGENT_DEFAULTS.temperature,
      maxTokens: AGENT_DEFAULTS.maxTokens
    });

    for await (const chunk of stream) {
      if (signal.aborted) return { content: '', toolCalls: [], aborted: true };

      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        if (reasoning.length < 200 || reasoning.length % 50 < 10) {
          activity.thinkingDelta(chunk.reasoning);
        }
      }

      if (chunk.content) {
        content += chunk.content;
        activity.textDelta(chunk.content);
      }

      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          if (!toolCallMap.has(tc.index)) {
            toolCallMap.set(tc.index, {
              id: tc.id ?? '',
              type: 'function',
              function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }
            });
          } else {
            const existing = toolCallMap.get(tc.index)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    return {
      content,
      toolCalls: Array.from(toolCallMap.values()),
      aborted: false
    };
  } catch (error) {
    activity.error((error as Error).message);
    return { content, toolCalls: [], aborted: true };
  }
}

interface ToolCallAccumulator {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function buildResult(
  activity: ActivityManager,
  toolCalls: Array<{ query: string; purpose: string; result: unknown }>,
  content: string
): TurnResult {
  return {
    message: {
      id: `msg-${activity['turnId']}-${Date.now()}`,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString()
    },
    events: activity.getEvents(),
    toolCalls
  };
}
```

- [ ] **Commit**

```bash
git add src/main/agent/AgentLoop.ts
git commit -m "feat(agent): add core AgentLoop with streaming and tool orchestration"
```

---

## Task 12: Rewrite `src/main/ipc.ts` — Delegate to Agent Loop

**Files:**
- Modify: `src/main/ipc.ts`

This is the biggest change. The monolithic `sendChat()` method (160+ lines) gets replaced
with a clean delegation to `AgentLoop`.

Key changes to `IpcController`:
1. Add `agentLoopConfig` as instance state
2. Add `getConnector()` public accessor
3. Replace `sendChat()` to use `runAgentLoop()`
4. Remove `runToolQueryLoop()` entirely
5. Remove `executeToolQuery()` — handled by tool registry now
6. Remove `buildResultAwareResponse()` — handled by the agent loop
7. Keep connection management, schema, settings, sessions unchanged
8. Add `abortChat(turnId)` method

```typescript
// Key additions to IpcController:

import { createToolRegistry } from './agent/tools';
import { runAgentLoop } from './agent/AgentLoop';
import { MemoryStore } from './agent/MemoryStore';
import { OpenRouterClient } from './model/OpenRouterClient';
import type { ToolRegistry } from './agent/ToolRegistry';

export class IpcController {
  private connector: DatabaseConnector | null = null;
  private schema: DatabaseSchema | null = null;
  private toolRegistry: ToolRegistry;
  private memoryStore: MemoryStore;
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(private store: AppStore) {
    this.toolRegistry = createToolRegistry();
    this.memoryStore = new MemoryStore();
    this.loadMemories();
  }

  getConnector(): DatabaseConnector | null {
    return this.connector;
  }

  async sendChat(
    messages: ModelChatMessage[],
    turnId?: string,
    webContents?: WebContents
  ): Promise<ChatTurnResponse> {
    const settings = this.store.loadSettings();
    const apiKey = this.store.getApiKey('openrouter');
    const id = turnId ?? crypto.randomUUID();

    if (!apiKey) {
      return {
        message: {
          id: `msg-${id}`,
          role: 'assistant',
          content: 'No OpenRouter API key configured. Add your API key in Settings to start chatting.',
          createdAt: new Date().toISOString()
        },
        events: []
      };
    }

    const client = new OpenRouterClient({ apiKey });

    const result = await runAgentLoop(messages, id, webContents, {
      model: settings.model,
      client,
      controller: this,
      memoryStore: this.memoryStore,
      toolRegistry: this.toolRegistry
    });

    return {
      message: result.message,
      events: result.events
    };
  }

  abortChat(turnId: string): void {
    const controller = this.activeAbortControllers.get(turnId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(turnId);
    }
  }

  // Keep existing methods: connect, getSchema, listModels, saveSettings, etc.
  // Remove: runToolQueryLoop, executeToolQuery, buildResultAwareResponse
  // Remove validateQuery from connect flow — no SAFE mode
}
```

- [ ] **Commit**

```bash
git add src/main/ipc.ts
git commit -m "refactor(ipc): delegate to AgentLoop, remove SAFE mode from controller"
```

---

## Task 13: Remove SAFE Mode & Validation Modules

**Files:**
- Delete: `src/main/connectors/sqliteValidation.ts`
- Delete: `src/main/connectors/mysqlValidation.ts`
- Delete: `src/main/connectors/postgresqlValidation.ts`
- Delete: `src/main/connectors/mongodbValidation.ts`
- Delete: `src/main/connectors/elasticsearchValidation.ts`
- Modify: All connector files (remove `validateQuery` method)
- Modify: `src/main/storage/AppStore.ts` (remove `safeMode` from settings)
- Modify: `src/main/assistant/localAssistant.ts` (remove entirely or replace with simpler fallback)
- Modify: `src/shared/types.ts` (remove `safeMode` from `PersistedSettings`)

Remove `validateQuery` from each connector. The `executeQuery` method no longer needs
a `mode` parameter — it just executes whatever query is passed.

Remove SAFE-mode toggle from UI in a later task.

- [ ] **Commit**

```bash
git rm src/main/connectors/*Validation.ts
git add src/main/connectors/ src/main/storage/AppStore.ts src/main/assistant/localAssistant.ts
git commit -m "refactor: remove SAFE mode and all validation modules"
```

---

## Task 14: Update IPC Bridge (`preload.cts` & `main.ts`)

**Files:**
- Modify: `src/preload/preload.cts`
- Modify: `src/main/main.ts`

Add `subscribeToAgentEvents` and `abortChat` to the preload API:

```typescript
// In preload.cts:
subscribeToAgentEvents: (turnId: string, listener: (event: unknown) => void) => {
  const channel = `dbchat:agent-event:${turnId}`;
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
},

abortChat: (turnId: string) => ipcRenderer.invoke('dbchat:abort-chat', turnId),
```

- [ ] **Commit**

```bash
git add src/preload/preload.cts src/main/main.ts
git commit -m "feat(ipc): add agent event subscription and abort to bridge"
```

---

## Task 15: Update Renderer for Streaming & New Agent Interface

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- [ ] **Update `sendChat` to consume streaming events**

Replace the current `sendChat` function to:
1. Subscribe to `api.subscribeToAgentEvents(turnId, callback)` 
2. Handle `text-delta` events by streaming text into the transcript
3. Handle `tool-start`/`tool-complete` by updating activity panel
4. Handle `thinking-delta` by showing reasoning if applicable
5. Handle `complete`/`error`/`aborted` as final state
6. Add an abort button during generation

The UI now receives incremental text deltas and appends them to a streaming message
in the transcript. When `complete` fires, the streaming message becomes the final
assistant message.

No changes to existing transcript rendering beyond adding the streaming message
during generation.

- [ ] **Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(renderer): add streaming text and new agent event handling"
```

---

## Task 16: Update Tests

**Files:**
- Modify: `test/App.test.tsx`
- Create: `src/main/agent/__tests__/AgentLoop.test.ts`
- Create: `src/main/agent/__tests__/ToolRegistry.test.ts`
- Create: `src/main/agent/__tests__/ContextManager.test.ts`
- Modify/Create: All existing test files that reference SAFE mode

Update existing tests to:
1. Remove `safeMode` references
2. Mock the new `api.subscribeToAgentEvents` in tests
3. Add tests for streaming scenarios
4. Add unit tests for ToolRegistry, ContextManager, ActivityManager

- [ ] **Commit**

```bash
git add test/ src/main/agent/__tests__/
git commit -m "test(agent): add harness tests, update existing tests for agent model"
```

---

## Task 17: Integration Verification

- [ ] **TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Test suite**

```bash
npm test
```

- [ ] **Build**

```bash
npm run build
```

- [ ] **Manual testing** — Launch app, verify:
  - Chat works with OpenRouter
  - Streaming text appears token-by-token
  - Tools execute and results feed back to model
  - Abort button cancels mid-generation
  - Memory tool saves and restores facts
  - Context compaction triggers on long conversations
  - Schema info tool returns correct data

- [ ] **Commit**

```bash
git add -A
git commit -m "chore: integration fixes and verification"
```

---

## Migration Checklist

| Component                  | Action                          |
|----------------------------|----------------------------------|
| `runToolQueryLoop()`       | Replace with `AgentLoop.ts` |
| `executeToolQuery()`       | Move to `RunDatabaseQueryTool.ts` |
| `buildResultAwareResponse()` | Integrated into agent loop |
| `buildSystemPrompt()` static | Replace with `prompts/system.ts` |
| SAFE mode                  | Remove entirely |
| All validation modules     | Delete |
| `extractQueryBlock()`      | Remove — native tool calling |
| `removeSqlBlocks()`        | Remove |
| `buildLocalAssistantResponse()` | Remove — show "no API key" state |
| `emitActivity` closure     | Replace with `ActivityManager` |
| `modelProviders` map       | Replace with `OpenRouterClient` |
| `openAIProvider`           | Remove — OpenRouter only |
| `openRouterProvider` (old) | Remove — replaced by SDK wrapper |
| `normalizeApiKey()`        | Keep — still used by store |

---

## Risk Assessment

| Risk                          | Likelihood | Mitigation                                |
|-------------------------------|------------|-------------------------------------------|
| Break existing chat flow      | Medium     | TDD — write agent tests first             |
| `@openrouter/sdk` issues      | Low        | Clean wrapper class, easy to swap         |
| Streaming causes UI jank      | Low        | React batch updates, throttle text-deltas |
| Context compaction loses data | Medium     | Conservative thresholds, test thoroughly  |
| Memory store bloats           | Low        | Prune at 100, cap by importance           |
| Test churn                    | High       | Progressive: update tests per task        |
