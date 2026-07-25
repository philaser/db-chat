# Reasoning Levels & Permission Controls — Implementation Plan

> **Source:** Agent harness analysis, OpenAI Agents SDK (guardrails + approvals), Anthropic Claude (thinking budget + effort), OpenCode (permission patterns + granular rules)
> **Date:** 2026-07-25

## Table of Contents

1. [Overview](#overview)
2. [Current State Analysis](#current-state-analysis)
3. [External Reference Implementations](#external-reference-implementations)
4. [Architecture: Reasoning / Effort Levels](#architecture-reasoning--effort-levels)
5. [Architecture: Permission / Approval System](#architecture-permission--approval-system)
6. [Shared Types & IPC Contract](#shared-types--ipc-contract)
7. [Settings & Persistence](#settings--persistence)
8. [UI Components](#ui-components)
9. [Testing Strategy](#testing-strategy)
10. [Migration & Rollout](#migration--rollout)

---

## Overview

DB Chat currently executes every tool call without user consent. The LLM can construct arbitrary SQL, invoke writes, and run unbounded queries. This plan adds two orthogonal safety layers found in every production agent harness:

1. **Reasoning/Effort Levels** — How much the model "thinks" before acting, controlling cost-vs-quality tradeoffs (inspired by OpenAI `reasoning.effort` and Anthropic `output_config.effort`).

2. **Permission/Approval System** — What the agent is allowed to do and whether it must ask first (inspired by OpenAI `needsApproval`, OpenCode `permission: allow|ask|deny`, and Anthropic's tool-authorization patterns).

---

## Current State Analysis

### What Exists

| Mechanism | File | Status |
|-----------|------|--------|
| Tool registry (4 tools) | `src/main/agent/ToolRegistry.ts` | No permission checks |
| Max rounds (10) | `src/main/agent/AgentLoop.ts:77` | Hardcoded, not user-configurable |
| Max parallel tools (5) | `src/main/agent/AgentLoop.ts:119` | Hardcoded |
| Max total tool calls (20) | `src/main/agent/AgentLoop.ts:120` | Hardcoded |
| Model call timeout (120s) | `src/main/agent/types.ts:9` | Defined, never enforced |
| Total timeout (300s) | `src/main/agent/types.ts:8` | Defined, never enforced |
| MongoDB read-only validation | `src/main/connectors/mongodbValidation.ts` | Present but partially unused |
| ES blocked keys | `src/main/connectors/elasticsearchValidation.ts` | `findBlockedKey` defined, never called |
| MySQL write detection | `src/main/connectors/MySQLConnector.ts:78` | Detects writes, doesn't block |
| SQLite validation | `src/main/connectors/SQLiteConnector.ts` | **None — raw SQL executes unchecked** |
| PostgreSQL validation | `src/main/connectors/PostgresConnector.ts` | **None — raw SQL executes unchecked** |
| System prompt advisory | `src/main/agent/prompts/system.ts:8` | "read-only" suggestion, not enforced |
| Abort mechanism | `src/main/ipc.ts:122` | Stub — AbortController never created |

### Critical Gaps

1. **No user-in-the-loop approval** — LLM calls any tool at any time without confirmation.
2. **No query validation** in SQLite/PostgreSQL — DDL, DML, unbounded reads all pass through.
3. **No read-only enforcement** — "read-only" is advisory text, not a code constraint.
4. **No row limits** for SQL connectors — unlike MongoDB (500) and ES (50/500).
5. **No audit trail** — tool calls and queries leave no record.
6. **No abort mechanism** — the `abortChat` stub has no implementation.
7. **No agent configuration** — all limits are hardcoded constants.

---

## External Reference Implementations

### OpenAI Agents SDK — Guardrails & Approvals

**Guardrails** are automatic validation hooks that run at three points:
- **Input guardrails** — block disallowed user requests before the main model runs (e.g., homework detection).
- **Output guardrails** — validate or redact output before it's returned.
- **Tool guardrails** — check tool arguments/behavior around function calls.

**Approvals** are the human-in-the-loop path:
- `needsApproval: true` on a tool definition causes the run to PAUSE.
- The SDK returns `interruptions` in the result along with a resumable `state`.
- Application calls `state.approve(interruption)` or `state.reject(interruption)`.
- State is serializable — supports delayed/offline review.
- Same pattern works for nested agents and handoffs.

Key design principles:
- Guardrails are lightweight, fast validation (predicates, not LLM calls).
- Approvals pause for human judgment, not algorithmic decisions.
- The state model is the backbone — runs pause cleanly and resume identically.

### Anthropic Claude — Thinking Budget & Effort

**Extended Thinking (deprecated on newer models):**
- `thinking: { type: "enabled", budget_tokens: N }` — manual control over reasoning depth.
- Budget capped at `max_tokens`, minimum 1,024 tokens.

**Adaptive Thinking (current recommended):**
- `thinking: { type: "adaptive" }` — Claude decides whether/how much to think.
- `output_config: { effort: "low" | "medium" | "high" }` — controls reasoning depth.
- At lower effort, Claude may skip thinking entirely on easy inputs.
- Interleaved thinking: model can reason between tool calls.

Key design principles:
- Effort is a steering hint, not a guarantee — the model adapts.
- Thinking tokens are internal, not visible in the output stream.
- Interleaved thinking preserves reasoning across tool calls.

### OpenCode — Permissions System

**Permission model** (`allow` | `ask` | `deny`):
- Per-tool: `read`, `edit`, `glob`, `grep`, `bash`, `task`, `skill`, `webfetch`, `websearch`, `question`, `lsp`
- Safety guards: `external_directory`, `doom_loop`
- Granular rules: pattern-matching against tool inputs (e.g., `"git commit *": "deny"`)
- `"*"` catch-all pattern + more specific overrides
- Last-match-wins evaluation order
- Agent-level permission overrides (merged with global, agent takes precedence)

**Auto mode** (`--auto`):
- Automatically approves non-denied permission requests
- Explicit `deny` rules still enforced
- TUI indicator shows `auto` mode status

**Approval flow** (`ask`):
- UI offers three outcomes: `once`, `always`, `reject`
- `always` whitelists a pattern for the session
- Tool provides a suggested pattern (e.g., `git status*`)

Key design principles:
- Granularity at the tool + input level (not just tool level)
- Session-scoped always-approve with suggested patterns
- Agent-scoped permission overrides
- Simple wildcard matching (not regex, not glob)

---

## Architecture: Reasoning / Effort Levels

### Model Support

OpenRouter passes `reasoning.effort` to supported models. The effort parameter is passed through to the upstream provider.

| Provider | Parameter | Values |
|----------|-----------|--------|
| OpenAI (o-series, gpt-5.x) | `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Anthropic (Claude 4.5+) | `thinking.budget_tokens` or `thinking: {type: "adaptive"}` | Token budget or adaptive + effort |
| Other providers | Ignored or mapped by OpenRouter | Varies |

### Design: Five-Level Effort Model

Map external complexity to a simple five-level selector:

| Level | Label | Behavior | Best For |
|-------|-------|----------|----------|
| 0 | **Fast** | No reasoning (pass `effort: "none"`) | Simple questions, schema lookups |
| 1 | **Low** | Minimal reasoning (pass `effort: "low"`) | Quick queries, data exploration |
| 2 | **Medium** (default) | Balanced reasoning (pass `effort: "medium"`) | Most tasks, analysis |
| 3 | **High** | Deep reasoning (pass `effort: "high"`) | Complex analysis, multi-step |
| 4 | **Max** | Maximum reasoning (pass `effort: "max"`) | Deep research, critical tasks |

### Data Flow

```
Settings UI (effort level selector)
  │
  ▼
PersistedSettings.effortLevel (AppStore)
  │
  ▼
IpcController.sendChat() ──► loads settings.effortLevel
  │
  ▼
runAgentLoop() ──► maps effortLevel to provider-specific param
  │                   │
  │   OpenAI:  { reasoning: { effort: "low"|"medium"|... } }
  │   Anthropic: { thinking: { type: "adaptive" },
  │                output_config: { effort: "low"|"medium"|"high" } }
  │                   │
  ▼                   ▼
OpenRouterClient.streamChat() ──► includes in API request body
  │
  ▼
Stream response (text deltas, thinking deltas if visible)
```

### Files Changed

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `EffortLevel` enum and `effortLevel` to `PersistedSettings` |
| `src/main/storage/AppStore.ts` | Persist `effortLevel` (default: `medium`) |
| `src/main/agent/types.ts` | Add `effortLevel` to agent configuration |
| `src/main/agent/AgentLoop.ts` | Pass effort to `streamModelResponse` |
| `src/main/model/OpenRouterClient.ts` | Include effort/reasoning params in API request |
| `src/main/ipc.ts` | Pass `effortLevel` from settings to agent loop |
| `src/renderer/App.tsx` | Add effort selector in Settings view |
| `src/renderer/styles.css` | Style effort level picker |

---

## Architecture: Permission / Approval System

### Permission Model

Borrow OpenCode's three-action model: **Allow**, **Ask**, **Deny**.

Each DB Chat tool registers its permission requirements:

| Tool | Default | Risk | Approvable |
|------|---------|------|------------|
| `get_schema_info` | `allow` | None (read-only metadata) | N/A |
| `sample_data` | `allow` | Low (reads with limit) | N/A |
| `run_database_query` | Depends on query | Depends | Yes |
| `save_memory` | `ask` | Low (local storage only) | Yes |

For `run_database_query`, permissions are further scoped by query type and connection safety level:

### Connection Safety Levels

Per-connection setting that gates what the agent can do:

| Level | Label | Description |
|-------|-------|-------------|
| `safe` | **Safe (Read-Only)** | Only `SELECT`/read queries. No DDL, no DML, row limits enforced. No approval needed for reads. |
| `standard` | **Standard** | Reads auto-approved, writes require user confirmation. DDL always denied. |
| `unrestricted` | **Unrestricted** | All queries allowed, all require confirmation. |

Default: `standard`.

### Query-Level Validation

For each connector, enforce query safety based on safety level:

**SQLite:**
- `safe` level: Validate query starts with `SELECT`, `WITH`, `EXPLAIN`, `PRAGMA` (read-only pragmas only). Deny everything else. Enforce `LIMIT` clause (add if missing, cap at 1000).
- `standard` level: Same read validation, writes require approval. DDL (`CREATE`, `DROP`, `ALTER`) always denied.
- `unrestricted` level: All queries require approval.

**PostgreSQL:** Same validation as SQLite (SQL grammar-based).

**MySQL:** Existing write detection reused. Extend to block DDL at `safe`/`standard` levels.

**MongoDB:** Existing `BLOCKED_AGGREGATION_STAGES` and `BLOCKED_KEYS` actually enforced. `safe` level adds `$out`/`$merge` blocking.

**Elasticsearch:** Existing `findBlockedKey` called during query execution. `safe` level enforced.

### Approval Flow (Inspired by OpenAI Agents SDK + OpenCode)

```
Agent Loop
  │
  ├─ Tool call requested ──► Check permission for (tool, input)
  │                              │
  │     ┌────────────────────────┤
  │     ▼                        ▼                        ▼
  │  allow                     ask                     deny
  │     │                        │                        │
  │     ▼                        ▼                        ▼
  │  Execute tool           Pause loop              Return error
  │                         Emit interrupt           to LLM
  │                              │
  │                              ▼
  │                    Renderer receives
  │                    'approval-required' event
  │                              │
  │                              ▼
  │                    UI shows approval dialog
  │                    (query text, tool, purpose)
  │                              │
  │           ┌──────────────────┼──────────────────┐
  │           ▼                  ▼                  ▼
  │        Approve            Deny           Always approve
  │           │                  │           (for this session)
  │           ▼                  ▼                  │
  │     IPC: approve     IPC: deny           Add to session
  │     interruption     interruption        allowlist
  │           │                  │                  │
  │           ▼                  ▼                  ▼
  │     Resume loop      Return error      Resume loop
  │     Execute tool      to LLM           Execute tool
  │
  ▼
Continue loop
```

### Interruption State Model (OpenAI-compatible)

```typescript
interface ApprovalInterruption {
  id: string;
  turnId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;         // Human-readable explanation
  risk: 'none' | 'low' | 'medium' | 'high';
  timestamp: string;
}

interface TurnState {
  turnId: string;
  messages: ModelChatMessage[];
  pendingInterruptions: ApprovalInterruption[];
  completedToolCalls: number;
  // Serializable — can be stored and resumed later
}
```

### Session Allowlist

User can approve a tool+pattern combination "always" for the session:

```
User clicks "Always allow SELECT queries on this table"
  → Session allowlist gets: { tool: "run_database_query", pattern: "SELECT.*FROM users.*" }
  → Future matching queries auto-approved for this session
```

### DB Query Approval GUI

The approval dialog shows:
- Tool name and purpose
- Full query text (syntax-highlighted)
- Risk assessment (DDL? DML? Unbounded? Write?)
- Action buttons: **Approve**, **Deny**, **Always allow pattern**

### Abort Mechanism (Now Actually Implemented)

Currently `abortChat` is a stub. Add:
- `AbortController` created in `IpcController.sendChat()`
- Passed through to `runAgentLoop()` and `streamModelResponse()`
- `AbortController.signal` passed to `fetch()` in `OpenRouterClient`
- Renderer's "abort" button calls `api.abortChat(turnId)` → IPC → `controller.abort()`

### Audit Log

New `AuditStore` (JSON file in app data directory):
```typescript
interface AuditEntry {
  id: string;
  timestamp: string;
  turnId: string;
  connectionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionDecision: 'allow' | 'ask' | 'deny' | 'approved' | 'denied';
  queryType?: 'read' | 'write' | 'ddl';
  rowCount?: number;
  elapsedMs?: number;
}
```

Viewable in Settings > Logs or a new "Audit" tab.

### Files Changed

**New files:**
| File | Purpose |
|------|---------|
| `src/main/agent/PermissionManager.ts` | Core permission logic: check tool/input against rules |
| `src/main/agent/ApprovalManager.ts` | Interruption state machine, session allowlist |
| `src/main/storage/AuditStore.ts` | Audit trail persistence |
| `src/main/connectors/QueryValidator.ts` | Unified SQL validation (DDL/DML detection, LIMIT enforcement) |

**Modified files:**
| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `ApprovalInterruption`, `TurnState`, `SafetyLevel`, `EffortLevel`, `AuditEntry`, `AgentEvent` types for `approval-required`/`approval-resolved` |
| `src/main/agent/types.ts` | Add `PermissionRule`, `PermissionSet`, `ApprovalState` |
| `src/main/agent/AgentLoop.ts` | Integrate permission check before tool execution, pause/resume on interrupt, AbortController support |
| `src/main/agent/ToolRegistry.ts` | Register tool permissions |
| `src/main/agent/ActivityManager.ts` | Add `emitApprovalRequired()` and `emitApprovalResolved()` |
| `src/main/ipc.ts` | Add `approveInterruption`, `denyInterruption`, `abortChat` (implement), `setSafetyLevel`, pass `AbortController` |
| `src/main/main.ts` | Register new IPC handlers |
| `src/main/storage/AppStore.ts` | Persist `effortLevel`, `safetyLevel` per connection, audit entries |
| `src/preload/preload.cts` | Add `approveInterruption`, `denyInterruption`, `abortChat`, `setSafetyLevel` bridge methods |
| `src/renderer/App.tsx` | Approval dialog UI, effort level settings, safety level selector, abort button wiring |
| `src/renderer/styles.css` | Approval dialog styles, effort picker styles |
| `src/main/connectors/SQLiteConnector.ts` | Add `QueryValidator` read-only enforcement, LIMIT cap |
| `src/main/connectors/PostgresConnector.ts` | Same as SQLite |
| `src/main/connectors/MySQLConnector.ts` | Block writes (not just detect) at `safe` level |
| `src/main/connectors/MongoDBConnector.ts` | Actually call `findBlockedAggregationStage`, `findBlockedKey` |
| `src/main/connectors/ElasticsearchConnector.ts` | Actually call `findBlockedKey` |

---

## Shared Types & IPC Contract

### New Types

```typescript
// Reasoning/Effort
type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

// Permissions
type PermissionAction = 'allow' | 'ask' | 'deny';

type SafetyLevel = 'safe' | 'standard' | 'unrestricted';

interface PermissionRule {
  toolName: string;
  action: PermissionAction;
  pattern?: string;        // For query-level granularity
  risk?: 'none' | 'low' | 'medium' | 'high';
}

interface ApprovalInterruption {
  id: string;
  turnId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  purpose: string;
  risk: 'none' | 'low' | 'medium' | 'high';
  queryPreview?: string;
  timestamp: string;
}

// Add to AgentEvent union
type AgentEvent =
  | { type: 'text-delta'; data: { delta: string } }
  | { type: 'thinking-delta'; data: { delta: string } }
  | { type: 'tool-start'; data: { toolName: string; purpose: string } }
  | { type: 'tool-complete'; data: { toolName: string; summary?: string } }
  | { type: 'status'; data: { message: string } }
  | { type: 'approval-required'; data: { interruption: ApprovalInterruption } }
  | { type: 'approval-resolved'; data: { interruptionId: string; approved: boolean } }
  | { type: 'complete' }
  | { type: 'error'; data: { message: string } }
  | { type: 'aborted' };

// Extend PersistedSettings
interface PersistedSettings {
  // ... existing
  effortLevel: EffortLevel;
}

// Extend ConnectionConfig
interface ConnectionConfig {
  // ... existing
  safetyLevel: SafetyLevel;
}

// Extend DbChatApi
interface DbChatApi {
  // ... existing
  approveInterruption(turnId: string, interruptionId: string): Promise<void>;
  denyInterruption(turnId: string, interruptionId: string): Promise<void>;
  abortChat(turnId: string): Promise<void>;
  setSafetyLevel(connectionId: string, level: SafetyLevel): Promise<void>;
}
```

---

## Settings & Persistence

### AppStore Additions

```typescript
// Defaults
DEFAULT_SETTINGS = {
  effortLevel: 'medium',
  safetyLevel: 'standard',   // Per-connection, stored with connection config
  // ... existing
}
```

### Per-Connection Safety Level

Stored in `ConnectionConfig.safetyLevel`. When connecting, the connector receives the safety level and configures validation accordingly. The safety level persists across sessions with the saved connection.

---

## UI Components

### Effort Level Picker (Settings)

```
Model Reasoning Effort:

[Fast] [Low] [Medium] [High] [Max]
  0      1      2       3      4
```

Five discrete buttons styled as a segmented control. Default: Medium.

### Safety Level Picker (Per Connection)

```
Safety Level:
○ Safe (Read-only)        — Only SELECT queries, row limits enforced
● Standard (Default)      — Writes require confirmation
○ Unrestricted            — All queries require confirmation
```

Radio group in the connection settings. Visible when editing a saved connection.

### Approval Dialog (Chat Page)

Modal overlay that appears when a tool call needs approval:

```
┌─────────────────────────────────────────────┐
│  ⚠️  Approval Required                       │
│                                             │
│  Database Query                              │
│  This action will read data from the DB.     │
│                                             │
│  ┌─────────────────────────────────────────┐ │
│  │ SELECT name, email                       │ │
│  │ FROM users                               │ │
│  │ WHERE created_at > '2024-01-01'          │ │
│  └─────────────────────────────────────────┘ │
│                                             │
│  Risk: ██░░ Low (read-only, limited)      │ │
│                                             │
│  [Approve]  [Always allow SELECT on users]   │
│  [Deny]                                      │
└─────────────────────────────────────────────┘
```

### Abort Button

During agent execution, the send button becomes a stop button (Loader2 replaced with Square/X icon). Clicking it calls `api.abortChat(turnId)`.

---

## Testing Strategy

### Unit Tests

| Test | File | What |
|------|------|------|
| PermissionManager allows `get_schema_info` without approval | `test/permissionManager.test.ts` | Always-allow tool |
| PermissionManager asks for `run_database_query` with write query | Same | Write detection triggers approval |
| PermissionManager denies `DROP TABLE` at safe level | Same | DDL blocking |
| QueryValidator blocks `DELETE` at safe level | `test/queryValidator.test.ts` | Read-only enforcement |
| QueryValidator adds LIMIT to unbounded SELECT | Same | Row limit enforcement |
| ApprovalManager pause/resume cycle | `test/approvalManager.test.ts` | Interruption state machine |
| ApprovalManager session allowlist | Same | Pattern matching |
| AbortController cancels streaming fetch | `test/agentLoop.test.ts` | Abort signal propagation |
| Effort level serialization | `test/appStore.test.ts` | Persistence round-trip |
| Effort level passed to OpenRouter client | `test/openRouterClient.test.ts` | API parameter mapping |

### Integration Tests

| Test | What |
|------|------|
| Full approval flow: send → interrupt → approve → complete | End-to-end IPC roundtrip |
| Full approval flow: send → interrupt → deny → error to LLM | Denial path |
| Abort mid-stream returns aborted event | Abort signal handling |
| Safety level changes mid-session (new connection required) | Runtime toggle |
| Effort level changes apply to next chat | Settings propagation |

### Renderer Tests

| Test | What |
|------|------|
| Approval dialog renders with query preview | `test/App.test.tsx` |
| Approve button fires IPC call | Same |
| Deny button fires IPC call | Same |
| "Always allow" pattern generated correctly | Same |
| Effort level picker changes persisted setting | Same |
| Abort button replaces send button during execution | Same |

---

## Migration & Rollout

### Backward Compatibility
- Existing connections default to `safetyLevel: 'standard'`
- Existing chats continue without approval (tools default to `allow` unless explicitly set to `ask`)
- Effort level defaults to `medium` (same behavior as no-effort on models that don't support reasoning)
- `abortChat` becomes functional without breaking existing calls (they just weren't doing anything before)

### Implementation Order (Recommended)

**Phase 1: Foundation (low risk)**
1. Add `EffortLevel` type, settings persistence, pass through to OpenRouter client
2. Add `QueryValidator` for SQL connectors (read-only enforcement, LIMIT caps)
3. Fix existing validation gaps (MongoDB `BLOCKED_AGGREGATION_STAGES`, ES `findBlockedKey`)

**Phase 2: Permission System (core)**
4. Create `PermissionManager` with tool-level allow/ask/deny
5. Integrate into `AgentLoop` before tool execution
6. Add `AbortController` to `AgentLoop` and `OpenRouterClient`

**Phase 3: Approval UI**
7. Add `approval-required`/`approval-resolved` events to `ActivityManager`
8. Create approval dialog component in renderer
9. Wire IPC for approve/deny/always-allow
10. Create `ApprovalManager` with session allowlist

**Phase 4: Connection Safety**
11. Add `SafetyLevel` per connection
12. Add safety level picker in connection settings
13. Wire safety level into connector validation

**Phase 5: Audit & Polish**
14. Create `AuditStore` for tool/query logging
15. Add audit viewer in Settings
16. Effort level picker in Settings UI
17. Abort button in chat composer
18. Comprehensive integration tests

### Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking existing chat flow | All new behaviors gated behind new settings; defaults match current behavior |
| Approval interrupts degrading UX | Show approval inline in chat, not as modal; allow "always approve" per pattern |
| Performance impact of validation | SQL parsing is regex-based, <1ms overhead; only runs on `run_database_query` tool |
| OpenRouter API compatibility | Effort parameter passed via OpenRouter's provider-agnostic `reasoning` field; falls through silently for unsupported models |
