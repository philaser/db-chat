# Agent Harness Research: Distilling Best Practices

> Research conducted 2026-07-25. Analyzed OpenCode, Claude Code (leaked), and OpenAI Codex for
> agent-architecture patterns applicable to DB Chat's data-analysis agent.

---

## 1. What Makes a Great Agent Harness?

After studying the three reference codebases, six universal patterns emerge that all successful
agent tools share. These are the pillars of a production-quality agent harness.

### The Six Pillars

| #  | Pillar                   | What it means                                                                          | Missing in DB Chat? |
|----|--------------------------|----------------------------------------------------------------------------------------|----------------------|
| 1  | **Agent Loop**           | A state machine that drives multi-turn tool calling with clear stop conditions.        | Partial — 5-round max, no state machine |
| 2  | **Tool Registry**        | Self-contained tool modules with typed schemas, descriptions, and execution logic.     | Partial — one hardcoded tool |
| 3  | **Streaming**            | Token-by-token text streaming + event streaming for tool calls and progress.           | **Missing** — only activity events streamed |
| 4  | **Context/Memory**       | Auto-compaction at context limits, persistent memory, conversation summarization.      | **Missing** — raw 16-message truncation |
| 5  | **Error Recovery**       | Graceful handling of model failures, tool failures, rate limits, and timeouts.          | Minimal — rethrow on failure |
| 6  | **Observer Pattern**     | Structured callbacks/hooks for tool start/end, model calls, errors, and status changes. | Partial — ad-hoc `emitActivity` |

---

## 2. Per-Repo Analysis

### 2.1 Claude Code (Anthropic — leaked source)

**Scale:** ~1,900 files, 512K+ LOC, TypeScript + Bun + Ink

Claude Code is the gold standard for agent harness design. Every architectural decision is
deliberate and production-hardened.

#### Agent Loop (`QueryEngine.ts`)

The core loop is a state machine with these stages:

```
[START] → send to model → [HAS TOOL CALLS?]
  ├─ Yes → execute tools in parallel → feed results back → go to [START]
  └─ No  → [IS ANSWER SUFFICIENT?]
              ├─ Yes → return final answer
              └─ No  → auto-continue (model asks user a question or requests next step)
```

Key characteristics:
- **Streaming first:** Every model call streams. The UI renders text as it arrives.
  Tool calls are parsed from the stream incrementally.
- **Thinking mode:** Models that support thinking (Claude, o1) get a dedicated thinking
  block that is rendered separately from the final answer.
- **Retry logic:** Exponential backoff for rate limits and transient errors, with
  automatic model fallback (try cheaper model if primary is overloaded).
- **Stop conditions:** Configurable — max turns, user interrupt (Ctrl+C), natural
  model stop signal.
- **Abort controller:** Every model call is wrapped in an `AbortController` so the
  user can cancel mid-generation.

#### Tool System

Every tool is a self-contained module implementing this interface:

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: ZodSchema;       // typed, validated input
  requiresPermission: boolean;   // does this need user approval?
  execute(args): Promise<ToolResult>;
  // Optional hooks
  onStart?(): void;
  onProgress?(update): void;
}
```

Tools are **not** hardcoded into the agent loop. They are registered in a `ToolRegistry`
and the loop dynamically passes them to the model. Adding a new tool requires zero changes
to the core loop.

**DB Chat takeaway:** Move from a single hardcoded `run_database_query` tool to a
pluggable tool registry. Future tools could include `visualize_data`, `export_report`,
`suggest_query`, etc.

#### Context/Memory System

- **`compact/` module:** When token usage exceeds the model's context limit, the
  conversation is automatically summarized by a secondary LLM call. The summary replaces
  the older messages, and the conversation continues. This is seamless and invisible to
  the user.

- **`memdir/` module:** Persistent memory — key facts, user preferences, and project
  context are stored in a directory and injected into the system prompt. The model can
  read/write memories via tools.

- **`extractMemories/` service:** After each conversation, important facts are
  automatically extracted and saved as persistent memories.

**DB Chat takeaway:** Auto-compaction is critical for long analysis sessions. Persistent
memory would store schema preferences, common query patterns, and domain knowledge.

#### Activity & Progress

- **React Ink components** render live activity in the terminal: spinner + current tool +
  tool result summaries.
- **Permission hooks** intercept every tool call and prompt the user for approval/denial,
  with options to approve for this session or always.
- **Task system:** The model can create/update a task list (similar to our todos) using
  `TaskCreateTool`/`TaskUpdateTool`. Tasks are rendered in the UI as a checklist.

#### Cost Tracking

- **`cost-tracker.ts`:** Every model call records token usage and cost. Displayed
  per-session and available via `/cost` command.

#### What DB Chat Should Adopt

| Feature                  | Priority | Reason                                                 |
|--------------------------|----------|--------------------------------------------------------|
| Tool Registry            | P0       | Foundation for extensible agent capabilities           |
| Streaming text           | P0       | User experience — see answers as they're written       |
| Thinking mode support    | P1       | OpenRouter exposes this via `x-openrouter-reasoning`   |
| Abort/cancel             | P0       | User must be able to stop a running analysis           |
| Auto-compaction          | P1       | Long schema-exploration sessions need this             |
| Persistent memory        | P1       | Store user domain knowledge, common queries            |
| Task tracking            | P2       | Nice-to-have for multi-step analysis                   |
| Cost tracking            | P2       | OpenRouter provides cost metadata in responses          |

---

### 2.2 OpenCode (open-source, Go + Bubble Tea)

**Scale:** ~185 commits, Go, SQLite storage, TUI

OpenCode is simpler than Claude Code but shares the same architectural philosophy at a
lower complexity level — making it a more accessible reference for DB Chat's scale.

#### Agent Loop

```
User message → Build system prompt + tools → Send to provider
  → [Tool calls?] → Execute tools → Feed results → Loop
  → [No tool calls?] → Render final answer
```

The loop is straightforward: it keeps going until the model stops calling tools or
a max-step limit is reached. Activity updates are pushed through a channel-based
event stream.

#### Auto-Compact

OpenCode's auto-compact is elegantly simple:

```go
if tokenCount > modelContextLimit * 0.95 {
    // Summarize the conversation so far
    summary := model.SendChat(summarizeSystemPrompt, conversation)
    // Create a new conversation with the summary as context
    newConversation := [systemPrompt, summary]
    // Append the last user message to maintain continuity
    newConversation = append(newConversation, lastUserMessage)
    // Continue from there
}
```

The key insight: **compact at 95% of context window**, not 100%. This prevents the model
from ever hitting a context error. The summary is a single system message that captures
the essence of the conversation.

#### Tool System

OpenCode's tools follow the same self-contained pattern but in Go:

```go
type Tool struct {
    Name        string
    Description string
    Parameters  ToolParams  // JSON Schema for parameters
    Execute     func(ctx, args) (ToolResult, error)
}
```

All tools are registered globally and injected into the system prompt at runtime.
The model receives the full tool list and decides which to call.

#### Session Management

- SQLite-backed — each conversation is a session with messages in the database.
- Sessions can be switched via `Ctrl+A`.
- Auto-compact creates new child sessions with the summary as context.

#### What DB Chat Should Adopt

| Feature                  | Priority | Reason                                                 |
|--------------------------|----------|--------------------------------------------------------|
| Auto-compact at 95%      | P0       | Simple, proven approach — adopt directly               |
| Session as first-class   | P1       | Already have sessions, but need compact branching       |
| Provider abstraction     | P1       | OpenCode's `internal/llm` module is clean reference    |

---

### 2.3 OpenAI Codex (Rust + TypeScript)

**Scale:** 8,597 commits, Rust core (codex-rs), JavaScript SDK

Codex has a different philosophy — it's a lightweight agent that delegates heavy thinking
to the model. The harness is intentionally minimal, relying on the model's native
tool-calling capabilities rather than building complex orchestration layers.

#### Key Design Principle: Simplicity

Codex's agent loop is the simplest of the three:

```
User request → System prompt + tools → Model responds
  → [Text] → Show to user
  → [Tool call] → Execute → Feed back → Repeat
```

No auto-compaction, no persistent memory, no task tracking. The philosophy is that
the model itself is intelligent enough to manage its own context within the conversation.

#### Code Execution Sandbox

Codex stands out for its sandboxed execution model. When the model generates code, it
runs in an isolated environment (via `bazel`) rather than on the user's machine. This is
the primary differentiator for Codex — not the agent loop itself, but the safety model.

#### Provider Abstraction

Codex uses the `openai` npm package as the provider abstraction. Requests are standard
OpenAI-compatible chat completions. No custom provider layer — it relies entirely on
the OpenAI API shape.

#### What DB Chat Should Adopt

| Feature                  | Priority | Reason                                                 |
|--------------------------|----------|--------------------------------------------------------|
| Simplicity-first design  | P0       | Don't over-engineer — let the model do the work        |
| Standard API shape       | P0       | Use OpenAI-compatible protocol via OpenRouter           |

---

## 3. OpenRouter SDK Deep Dive

OpenRouter offers three integration layers. For DB Chat, the right choice depends on
how much of the agent loop we want to own vs. delegate.

### Layer 1: Direct API (Current DB Chat Approach)

```typescript
fetch('https://openrouter.ai/api/v1/chat/completions', { ... })
```

- Pro: No dependencies, full control
- Con: Manual retry logic, manual streaming parsing, manual tool execution
- **Assessment:** Too low-level for a production agent

### Layer 2: Client SDK (`@openrouter/sdk`)

```typescript
import { OpenRouter } from '@openrouter/sdk';
const client = new OpenRouter({ apiKey });
const completion = await client.chat.send({ model, messages });
```

- Pro: Type-safe, streaming support, automatic retries
- Con: Still need to build our own agent loop
- **Assessment:** Right for DB Chat — gives us streaming + types without taking over
  the agent loop

### Layer 3: Agent SDK (`@openrouter/agent`)

```typescript
import { OpenRouter, tool } from '@openrouter/agent';
const result = openrouter.callModel({ model, messages, tools: [myTool] });
```

- Pro: Auto tool execution loop, Zod-based tool schemas, streaming
- Con: Newer/less battle-tested, might not fit DB Chat's specific needs
- **Assessment:** Worth adopting for the tool infrastructure, but DB Chat should own
  the agent loop for custom activity streaming and context management

### Recommended Integration

```
┌─────────────────────────────────────┐
│ DB Chat Agent Harness (we own)       │
│  ├── Agent Loop (state machine)      │
│  ├── Tool Registry                   │
│  ├── Context Manager (auto-compact)  │
│  ├── Memory System                   │
│  ├── Activity Stream (IPC to UI)     │
│  └── Session Manager                 │
│                                     │
│  ── uses ──                         │
│                                     │
│  @openrouter/sdk                    │
│  ├── client.chat.send()             │
│  ├── client.chat.stream()           │
│  └── client.models.list()           │
└─────────────────────────────────────┘
```

Use the Client SDK as the transport layer. Build the agent harness on top. Do NOT
use the Agent SDK's `callModel` — we need full control over the loop for DB-specific
features (activity streaming, SAFE-mode replacement, schema context injection).

---

## 4. Current DB Chat Architecture: Gap Analysis

Based on the explore agent's thorough analysis of the current codebase:

### Current Strengths (Keep)

| Component            | Why it works                                           |
|----------------------|--------------------------------------------------------|
| `DatabaseConnector`  | Clean interface, well-abstracted across 5 DB kinds     |
| `ModelProvider`      | Good provider abstraction, easy to add new ones        |
| `IpcController`      | Solid IPC orchestration pattern                        |
| `AppStore`           | Functional persistence, good for small data            |
| `ChatTurnResponse`   | Good response type, captures all data the UI needs      |
| `emitActivity`       | Working activity stream pattern                        |

### Critical Weaknesses (Replace)

| Component            | Why it fails                                           |
|----------------------|--------------------------------------------------------|
| `runToolQueryLoop`   | Monolithic, hardcoded 1 tool, no state machine         |
| No streaming         | Answers appear all at once — terrible UX for long responses |
| No context management| Raw 16-message truncation, no compaction               |
| `sendChat` method    | 160-line monolithic function, impossible to test       |
| SAFE mode            | User explicitly wants this removed                     |
| `buildSystemPrompt`  | Static prompt, no adaptation, no memory injection       |
| `extractQueryBlock`  | Regex-based SQL extraction is fragile                  |

### What to Build From Scratch

1. **Agent Loop** (`src/main/agent/AgentLoop.ts`) — State machine driving the conversation
2. **Tool Registry** (`src/main/agent/ToolRegistry.ts`) — Pluggable tool collection
3. **Streaming Layer** (`src/main/model/OpenRouterClient.ts`) — Wraps `@openrouter/sdk`
4. **Context Manager** (`src/main/agent/ContextManager.ts`) — Auto-compaction, memory
5. **Memory Store** (`src/main/agent/MemoryStore.ts`) — Persistent fact storage
6. **Activity Manager** (`src/main/agent/ActivityManager.ts`) — Structured progress events

### What to Remove

1. `runToolQueryLoop()` — replaced by Agent Loop
2. `buildResultAwareResponse()` — merged into Agent Loop's second-stage response
3. `buildSystemPrompt()` static version — replaced by dynamic prompt builder with memory
4. SAFE mode (`safeMode` setting, `QueryExecutionMode` type, all validation modules)
5. All five validation modules (`sqliteValidation.ts`, etc.) — removed with SAFE mode
6. `extractQueryBlock()` regex — replaced by native tool calling
7. `removeSqlBlocks()` — no longer needed since we use tool calls
8. `buildLocalAssistantResponse()` — local fallback is poor UX; show a clear "no LLM" state instead

---

## 5. Design Decisions for DB Chat's Agent Harness

### 5.1 Agent Loop State Machine

```
                       ┌──────────────────┐
                       │     IDLE         │
                       └──────┬───────────┘
                              │ user sends message
                              ▼
                       ┌──────────────────┐
              ┌───────│   THINKING       │
              │       └──────┬───────────┘
              │              │ model responds
              │              ▼
              │       ┌──────────────────┐
              │       │  PROCESSING      │──── (text only) ────► COMPLETE
              │       └──────┬───────────┘
              │              │ tool calls
              │              ▼
              │       ┌──────────────────┐
              │       │  EXECUTING       │──── (error) ────► ABORTED
              │       └──────┬───────────┘
              │              │ tool results ready
              └──────────────┘
                             │ (max turns reached)
                             ▼
                      ┌──────────────────┐
                      │    COMPLETE      │
                      └──────────────────┘
```

States:
- `IDLE` — waiting for user input
- `THINKING` — model is generating (streaming text to UI)
- `PROCESSING` — evaluating model response (text vs tool calls)
- `EXECUTING` — running tool calls, collecting results
- `COMPLETE` — final answer ready, conversation saved
- `ABORTED` — user cancelled or error occurred

The loop controller manages transitions between these states, enforcing:
- Max turns: 10 (up from 5)
- Max parallel tool calls: 5 (up from 3)
- Max total tool calls: 20 (up from 8)
- User interrupt: abort at any state
- Timeout: 5 minutes total, 2 minutes per model call

### 5.2 Tool Architecture

Every tool is a file in `src/main/agent/tools/` following this pattern:

```typescript
// src/main/agent/tools/RunDatabaseQueryTool.ts
export const runDatabaseQueryTool: AgentTool = {
  name: 'run_database_query',
  description: 'Execute a database query against the connected database.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'SQL or JSON query to execute' },
      purpose: { type: 'string', description: 'Why this query is needed' }
    },
    required: ['query', 'purpose']
  },
  execute: async (input: { query: string; purpose: string }, context: AgentContext) => {
    // Validate, execute, return result
    return { columns, rows, rowCount, elapsedMs };
  }
};
```

Tools planned for initial release:
1. `run_database_query` — Execute any read query
2. `get_schema_info` — Browse tables, columns, types
3. `sample_data` — Get example rows from a table
4. `save_memory` — Store a fact for future reference

Tools planned for future:
5. `visualize_data` — Generate chart configuration
6. `export_report` — Export analysis as formatted text
7. `search_memory` — Find relevant facts from memory

### 5.3 Streaming Architecture

```
Model generates tokens ──► OpenRouter SDK stream ──► Agent Loop
                                                         │
                          ┌──────────────────────────────┴──────────────────┐
                          ▼                              ▼                   ▼
                    textToken event              toolCall event         status event
                          │                              │                   │
                          ▼                              ▼                   ▼
                    Renderer updates             Tool Registry         Activity stream
                    text in transcript           executes tool         updates sidebar
```

The key change: **text content streams token-by-token to the UI**. The current code
receives the entire response at once. With streaming, the user sees the answer appear
in real-time, which is critical for long analytical responses.

Events streamed to the UI:
| Event Type       | Payload                            | UI Action                         |
|------------------|-------------------------------------|-----------------------------------|
| `text-delta`     | `{ turnId, delta: string }`        | Append text to transcript         |
| `tool-start`     | `{ turnId, toolName, purpose }`    | Show "Running {purpose}" activity |
| `tool-progress`  | `{ turnId, step: ActivityStep }`   | Update activity step status       |
| `tool-complete`  | `{ turnId, toolName, summary }`    | Show tool result summary          |
| `thinking-start` | `{ turnId }`                       | Show thinking indicator           |
| `thinking-delta` | `{ turnId, delta: string }`        | Show reasoning (if supported)     |
| `status`         | `{ turnId, status: string }`       | Update status bar                 |
| `complete`       | `{ turnId, message }`              | Finalize, persist session         |
| `error`          | `{ turnId, error: string }`        | Show error, offer retry           |
| `aborted`        | `{ turnId }`                       | Show cancelled state              |

### 5.4 Context & Memory Management

#### Context Window Strategy

```typescript
const CONTEXT_HIGH_WATER = 0.75;  // Start compacting at 75% of context window
const CONTEXT_CRITICAL = 0.90;    // Emergency compact at 90%
const MAX_MESSAGES = 50;          // Hard cap on message count
```

**Auto-compaction flow:**
1. Before each model call, estimate token count of conversation
2. If > 75% of model context limit, trigger compaction:
   a. Send the first N messages to a cheaper/faster model for summarization
   b. Replace those N messages with a single system message: `[Context from earlier: {summary}]`
   c. Keep the last M messages (most recent) intact
   d. Continue the conversation
3. If > 90% even after compaction, force-compact with a more aggressive summary
4. Never compact the current user message or the last assistant response

#### Persistent Memory

```typescript
interface Memory {
  id: string;
  content: string;        // The fact or preference
  category: 'schema' | 'domain' | 'preference' | 'query' | 'note';
  importance: number;     // 1-10, higher = kept longer
  createdAt: string;
  lastAccessedAt: string;
}
```

- User can explicitly add memories via the UI or chat
- The system can extract memories from conversations using a separate LLM call
- Memories are injected into the system prompt in a dedicated section
- Stored in `AppStore` alongside existing data

### 5.5 OpenRouter Integration

**SDK:** `@openrouter/sdk`

```typescript
import { OpenRouter } from '@openrouter/sdk';

const client = new OpenRouter({
  apiKey: store.getApiKey('openrouter'),
  httpReferer: 'https://github.com/philaser/db-chat',
  appTitle: 'DB Chat'
});
```

**Streaming call:**
```typescript
const stream = await client.chat.stream({
  model: settings.model,
  messages: buildMessages(context),
  tools: toolRegistry.getOpenAiTools(),
  temperature: 0.2,
  max_tokens: 4096
});

for await (const chunk of stream) {
  if (chunk.choices[0]?.delta?.content) {
    emitEvent('text-delta', { turnId, delta: chunk.choices[0].delta.content });
  }
  if (chunk.choices[0]?.delta?.tool_calls) {
    accumulateToolCalls(chunk.choices[0].delta.tool_calls);
  }
}
```

**Reasoning support** (Claude, o1, DeepSeek): OpenRouter exposes thinking tokens via
the `choices[0].delta.reasoning_content` field. We'll expose this as `thinking-delta` events.

---

## 6. File Structure for New Agent Harness

```
src/main/agent/
├── index.ts                    # Exports AgentLoop, ToolRegistry, etc.
├── AgentLoop.ts                # State machine, main orchestration
├── AgentLoop.ts                # State machine, main orchestration
├── ToolRegistry.ts             # Tool registration, discovery, execution
├── ContextManager.ts           # Auto-compaction, token estimation
├── MemoryStore.ts              # Persistent fact/preference storage
├── ActivityManager.ts          # Structured event streaming
├── types.ts                    # Agent-specific types
│
├── tools/
│   ├── index.ts                # Tool registration
│   ├── RunDatabaseQueryTool.ts  # Execute queries
│   ├── GetSchemaInfoTool.ts    # Browse schema
│   ├── SampleDataTool.ts       # Get sample rows
│   └── SaveMemoryTool.ts       # Store fact for future
│
├── prompts/
│   ├── system.ts               # Dynamic system prompt builder
│   ├── compaction.ts           # Prompt for conversation summarization
│   └── memory-extraction.ts    # Prompt for extracting memories
│
└── __tests__/
    ├── AgentLoop.test.ts
    ├── ToolRegistry.test.ts
    ├── ContextManager.test.ts
    └── tools/

src/main/model/
├── providers.ts                # Simplified — only OpenRouter
├── OpenRouterClient.ts         # @openrouter/sdk wrapper

src/main/ipc.ts                 # Much simplified — delegates to AgentLoop
src/shared/types.ts             # Updated — remove SAFE-mode, add agent types
```

---

## 7. Summary: What DB Chat Should Build

| Layer              | Current State          | Target State                                            |
|--------------------|------------------------|---------------------------------------------------------|
| Agent Loop         | 5-round max, 1 tool    | State machine, 10 rounds, pluggable tools, streaming    |
| Tools              | 1 hardcoded tool       | 4+ pluggable tools in `src/main/agent/tools/`           |
| Streaming          | Activity events only   | Full text streaming + tool progress events               |
| Context            | 16-message truncation  | Auto-compaction at 75%, persistent memory               |
| Memory             | None                   | `MemoryStore` with extraction and injection             |
| Provider           | fetch + 2 providers    | `@openrouter/sdk` wrapper, OpenRouter only              |
| SAFE Mode          | Enabled by default     | **Removed entirely**                                    |
| Error Handling     | Rethrow on failure     | Graceful recovery: retry, fallback, user notification   |
| Abort/Cancel       | None                   | `AbortController` on every model call                   |
| Activity Streaming | `emitActivity` closure | Structured `ActivityManager` with event types            |
| System Prompt      | Static template        | Dynamic builder with memory injection                   |
