import type { EffortLevel, ChatMessage, ModelChatMessage, AgentEvent, AgentToolResult, QueryResultArtifact, ConnectionKnowledge, TurnMetrics } from '../../shared/types.js';
import { ToolRegistry } from './ToolRegistry.js';
import { ActivityManager } from './ActivityManager.js';
import { ContextManager } from './ContextManager.js';
import { MemoryStore } from './MemoryStore.js';
import { AGENT_PROMPT_VERSION, buildSystemPrompt, renderSchemaContext } from './prompts/system.js';
import { AGENT_DEFAULTS, type AgentController, type AgentModelClient, type ToolContext } from './types.js';
import { PermissionManager } from './PermissionManager.js';
import { ApprovalManager } from './ApprovalManager.js';

export interface AgentLoopConfig {
  effortLevel?: EffortLevel;
  model: string;
  client: AgentModelClient;
  controller: AgentController;
  memoryStore: MemoryStore;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  approvalManager: ApprovalManager;
  signal?: AbortSignal;
  maxTurnRounds?: number;
  maxParallelTools?: number;
  maxTotalToolCalls?: number;
  permissionDeniedMessage?: string;
  referencedArtifacts?: QueryResultArtifact[];
  knowledge?: ConnectionKnowledge;
  runtime?: { currentTimeUtc?: string; timezone?: string; maxResultRows?: number; maxResultBytes?: number };
  requestExport?: ToolContext['requestExport'];
  requestReport?: ToolContext['requestReport'];
}

export interface TurnResult {
  message: ChatMessage;
  events: AgentEvent[];
  artifacts: QueryResultArtifact[];
  toolCalls: Array<{ query: string; purpose: string; result: unknown }>;
  metrics?: TurnMetrics;
}

export async function runAgentLoop(
  messages: ModelChatMessage[],
  turnId: string,
  listener: ((event: AgentEvent) => void) | undefined,
  config: AgentLoopConfig
): Promise<TurnResult> {
  config = { ...config, signal: AbortSignal.any([
    ...(config.signal ? [config.signal] : []),
    AbortSignal.timeout(AGENT_DEFAULTS.totalTimeoutMs)
  ]) };
  config.signal?.throwIfAborted();
  const activity = new ActivityManager(turnId, listener);
  const context = new ContextManager(config.client, config.model);
  const startedAtMs = Date.now();
  const phaseDurationsMs: Record<string, number> = {};
  const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
  let retryCount = 0;
  let queryCount = 0;
  let firstUsefulMs: number | undefined;

  const schemaStarted = performance.now();
  const connector = config.controller.getConnector();
  const schema = await config.controller.getSchema();
  phaseDurationsMs.schema = Math.round(performance.now() - schemaStarted);

  const toolContext: ToolContext = {
    turnId,
    signal: config.signal,
    controller: config.controller,
    connector,
    schema,
    requestExport: config.requestExport,
    requestReport: config.requestReport,
    emitEvent: (event) => activity.emit(event.type, event.data)
  };

  const schemaContext = renderSchemaContext(schema);

  const schemaKind = schema?.kind ?? 'sqlite';
  const memories = config.memoryStore.getRelevant(10);

  const tools = config.toolRegistry.getOpenAiTools();
  const toolsSection = config.toolRegistry.getSystemPromptSection();

  let conversation: ModelChatMessage[] = [];

  const systemPrompt = buildSystemPrompt({
    schemaContext,
    schemaKind,
    memories,
    knowledge: config.knowledge,
    runtime: config.runtime,
    toolsSection
  });
  conversation.push({ role: 'system', content: systemPrompt });

  const userAssistantMessages = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  );
  conversation.push(...userAssistantMessages.map(({ role, content }) => ({ role, content })));

  activity.status('Thinking...');

  let totalToolCalls = 0;
  const allToolCalls: Array<{ query: string; purpose: string; result: unknown }> = [];
  const artifacts: QueryResultArtifact[] = [];
  const artifactCatalog = new Map((config.referencedArtifacts ?? []).map((artifact) => [artifact.queryId, artifact]));
  toolContext.resolveArtifact = (resultId) => artifactCatalog.get(resultId);
  toolContext.allocateResultId = () => `${turnId}-query-${artifacts.length + 1}`;
  const maxTurnRounds = config.maxTurnRounds ?? AGENT_DEFAULTS.maxTurnRounds;
  const maxParallelTools = config.maxParallelTools ?? AGENT_DEFAULTS.maxParallelTools;
  const maxTotalToolCalls = config.maxTotalToolCalls ?? AGENT_DEFAULTS.maxTotalToolCalls;
  const failedCallSignatures = new Map<string, number>();
  let unresolvedQueryFailure = false;
  let queryRepairPromptUsed = false;
  const onToolResult = (toolName: string, input: Record<string, unknown>, result: AgentToolResult) => {
    if (toolName === 'run_database_query') {
      if (result.ok) unresolvedQueryFailure = false;
      else if (result.data?.errorCode === 'QUERY_EXECUTION_FAILED') unresolvedQueryFailure = true;
    }
    if (toolName === 'run_database_query' || toolName === 'sample_data') queryCount += 1;
    if (toolName === 'run_database_query' && result.ok) firstUsefulMs ??= Date.now() - startedAtMs;
    if (!result.ok) {
      const signature = `${toolName}:${canonicalJson(input)}`;
      failedCallSignatures.set(signature, (failedCallSignatures.get(signature) ?? 0) + 1);
      retryCount += 1;
    }
  };

  try {
    for (let round = 0; round < maxTurnRounds; round++) {
      if (config.signal?.aborted) {
        config.signal.throwIfAborted();
      }
      const contextStarted = performance.now();
      const snapshot = await context.compact(
        conversation,
        memories,
        schemaContext,
        128000,
        config.signal
      );
      phaseDurationsMs.context = (phaseDurationsMs.context ?? 0) + Math.round(performance.now() - contextStarted);
      conversation = snapshot.messages;

      activity.status(round === 0 ? 'Analyzing...' : 'Continuing analysis...');
      const modelStarted = performance.now();
      const modelResponse = await streamModelResponse(
        config.client,
        config.model,
        snapshot.messages,
        tools,
        activity,
        config.signal,
        config.effortLevel
      );
      phaseDurationsMs.model = (phaseDurationsMs.model ?? 0) + Math.round(performance.now() - modelStarted);
      accumulateUsage(tokenUsage, modelResponse.usage);

      if (modelResponse.toolCalls.length === 0) {
        if (unresolvedQueryFailure && !queryRepairPromptUsed && round + 1 < maxTurnRounds && totalToolCalls < maxTotalToolCalls && modelResponse.finishReason !== 'length') {
          queryRepairPromptUsed = true;
          conversation.push({ role: 'assistant', content: modelResponse.content || null });
          conversation.push({ role: 'user', content: 'The database query failed and no corrected query has succeeded. If this is a fixable syntax or input issue, execute the corrected read-only query now. Otherwise explain the limitation. Do not promise a retry without performing it, repeat an identical failing query, or claim completion without evidence.' });
          continue;
        }
        const content = hydrateValidatedStructuredOutput(modelResponse.content.trim().normalize('NFC'), allToolCalls);
        const lengthLimited = modelResponse.finishReason === 'length';
        const evidenceNote = artifacts.length > 0 ? ' The verified results remain available above.' : '';
        const finalContent = lengthLimited
          ? `${content}${content ? '\n\n' : ''}This response is incomplete because it reached the length limit.${evidenceNote}`
          : unresolvedQueryFailure ? `This analysis is incomplete because the database query failed. Retry or edit the question to continue.${evidenceNote}`
          : content || `I could not complete the analysis.${evidenceNote}`;
        const terminalReason: TurnMetrics['terminalReason'] = lengthLimited ? 'length' : unresolvedQueryFailure ? 'incomplete' : content ? 'completed' : 'incomplete';
        activity.textDelta(finalContent);
        firstUsefulMs ??= Date.now() - startedAtMs;
        return buildResult(
          activity,
          allToolCalls,
          artifacts,
          finalContent,
          buildMetrics(config.model, startedAtMs, firstUsefulMs, phaseDurationsMs, queryCount, totalToolCalls, retryCount, tokenUsage, terminalReason)
        );
      }

      const assistantContent = modelResponse.content || null;
      const assistantMessage: ModelChatMessage = {
        role: 'assistant',
        content: assistantContent,
        tool_calls: modelResponse.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }))
      };
      conversation.push(assistantMessage);

      let pendingCalls = modelResponse.toolCalls.slice(0, maxParallelTools);
      if (totalToolCalls + pendingCalls.length > maxTotalToolCalls) {
        pendingCalls = pendingCalls.slice(
          0,
          maxTotalToolCalls - totalToolCalls
        );
      }

      const permittedIds = new Set(pendingCalls.map((call) => call.id));
      for (const call of modelResponse.toolCalls) {
        if (!permittedIds.has(call.id)) {
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'Tool execution limit reached. Reduce the number of requested tools.' }) });
        }
      }
      const roundCallStart = allToolCalls.length;
      for (const call of pendingCalls) {
        config.signal?.throwIfAborted();
        const toolName = call.function.name;
        const rawSignature = `${toolName}:${call.function.arguments}`;
        if ((failedCallSignatures.get(rawSignature) ?? 0) >= 2) {
          const repeated: AgentToolResult = {
            ok: false,
            summary: 'This identical malformed tool call already failed twice. Change the input or finish with an explicit limitation.',
            error: 'Repeated malformed tool call blocked',
            data: { errorCode: 'REPEATED_TOOL_FAILURE', retryable: false }
          };
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(repeated) });
          activity.toolStart(toolName);
          activity.toolComplete(toolName, repeated.summary);
          allToolCalls.push({ query: call.function.arguments, purpose: toolName, result: repeated });
          retryCount += 1;
          totalToolCalls += 1;
          continue;
        }
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool input must be a JSON object.');
          input = parsed as Record<string, unknown>;
        } catch (error) {
          const attempts = (failedCallSignatures.get(rawSignature) ?? 0) + 1;
          failedCallSignatures.set(rawSignature, attempts);
          retryCount += 1;
          const invalid: AgentToolResult = {
            ok: false,
            summary: 'The tool input was malformed. Send one valid JSON object.',
            error: error instanceof Error ? error.message : 'Malformed tool input',
            data: { errorCode: 'INVALID_TOOL_ARGUMENTS', retryable: attempts < 2, attempts }
          };
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(invalid) });
          activity.toolStart(toolName);
          activity.toolComplete(toolName, invalid.summary);
          allToolCalls.push({ query: call.function.arguments, purpose: toolName, result: invalid });
          totalToolCalls++;
          continue;
        }

        const callSignature = `${toolName}:${canonicalJson(input)}`;
        if ((failedCallSignatures.get(callSignature) ?? 0) >= 2) {
          const repeated: AgentToolResult = {
            ok: false,
            summary: 'This identical tool call already failed twice. Change the input or finish with an explicit limitation.',
            error: 'Repeated failing tool call blocked',
            data: { errorCode: 'REPEATED_TOOL_FAILURE', retryable: false }
          };
          conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(repeated) });
          activity.toolStart(toolName, input.purpose as string);
          activity.toolComplete(toolName, repeated.summary);
          allToolCalls.push({ query: (input.query as string) ?? JSON.stringify(input), purpose: (input.purpose as string) ?? toolName, result: repeated });
          retryCount += 1;
          totalToolCalls += 1;
          continue;
        }

        const permission = config.permissionManager.check(toolName, input);

        if (permission === 'deny') {
          const currentLevel = config.permissionManager.getSafetyLevel();
          const denial = config.permissionDeniedMessage
            ?? `Blocked by safety level "${currentLevel}". The user can switch to a higher safety level (elevated or unrestricted) in the composer footer to allow this operation.`;
          const denyResult: AgentToolResult = {
            ok: false,
            summary: denial,
            error: denial
          };
          const toolMessage: ModelChatMessage = {
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(denyResult)
          };
          conversation.push(toolMessage);
          activity.toolStart(toolName, input.purpose as string);
          activity.toolComplete(toolName, denyResult.summary);
          allToolCalls.push({
            query: (input.query as string) ?? JSON.stringify(input),
            purpose: (input.purpose as string) ?? toolName,
            result: denyResult
          });
          config.controller.audit({
            turnId,
            connectionId: config.controller.getConnectionId(),
            toolName,
            toolInput: input,
            permissionDecision: 'deny',
            queryPreview: (input.query as string) ?? undefined
          });
          totalToolCalls++;
          continue;
        }

        if (permission === 'ask') {
          if (config.approvalManager.isAllowedBySession(toolName, input)) {
            await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls, artifacts, artifactCatalog, phaseDurationsMs, onToolResult);
            totalToolCalls++;
            continue;
          }

          const interruption = config.approvalManager.createInterruption(turnId, toolName, input);
          activity.approvalRequired({
            id: interruption.id,
            turnId: interruption.turnId,
            toolName: interruption.toolName,
            toolInput: interruption.toolInput,
            purpose: interruption.purpose,
            risk: interruption.risk,
            queryPreview: interruption.queryPreview,
            timestamp: interruption.timestamp
          });

          const approved = await config.approvalManager.waitForDecision(interruption.id, config.signal);
          activity.approvalResolved(interruption.id, approved);

          config.controller.audit({
            turnId,
            connectionId: config.controller.getConnectionId(),
            toolName,
            toolInput: input,
            permissionDecision: approved ? 'approved' : 'denied',
            queryPreview: (input.query as string) ?? undefined
          });

          if (approved) {
            await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls, artifacts, artifactCatalog, phaseDurationsMs, onToolResult);
            totalToolCalls++;
          } else {
            const denyResult: AgentToolResult = {
              ok: false,
              summary: `Tool "${toolName}" was denied by user`,
              error: 'User denied the tool execution'
            };
            const toolMessage: ModelChatMessage = {
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(denyResult)
            };
            conversation.push(toolMessage);
            activity.toolStart(toolName, input.purpose as string);
            activity.toolComplete(toolName, denyResult.summary);
            allToolCalls.push({
              query: (input.query as string) ?? JSON.stringify(input),
              purpose: (input.purpose as string) ?? toolName,
              result: denyResult
            });
            totalToolCalls++;
          }

          continue;
        }

        await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls, artifacts, artifactCatalog, phaseDurationsMs, onToolResult);
        totalToolCalls++;
      }
      const roundResults = allToolCalls.slice(roundCallStart).map((call) => call.result as AgentToolResult);
      const finalReport = roundResults.at(-1);
      if (pendingCalls.at(-1)?.function.name === 'create_report'
        && pendingCalls.length === modelResponse.toolCalls.length
        && roundResults.length === pendingCalls.length
        && roundResults.every((result) => result.ok)
        && finalReport?.data?.finalize === true
        && !unresolvedQueryFailure
        && modelResponse.finishReason !== 'length') {
        config.signal?.throwIfAborted();
        const content = hydrateValidatedStructuredOutput('', allToolCalls);
        activity.textDelta(content);
        firstUsefulMs ??= Date.now() - startedAtMs;
        return buildResult(activity, allToolCalls, artifacts, content,
          buildMetrics(config.model, startedAtMs, firstUsefulMs, phaseDurationsMs, queryCount, totalToolCalls, retryCount, tokenUsage, 'completed'));
      }
    }

    activity.status('Preparing an incomplete answer...');
    const incompleteText = artifacts.length > 0
      ? 'This analysis is incomplete because the bounded tool or reasoning budget was reached. The verified results remain available above; narrow the question or continue from a result to finish.'
      : 'This analysis is incomplete because the bounded tool or reasoning budget was reached. Narrow the question and try again.';
    activity.textDelta(incompleteText);
    firstUsefulMs ??= Date.now() - startedAtMs;
    return buildResult(activity, allToolCalls, artifacts, incompleteText,
      buildMetrics(config.model, startedAtMs, firstUsefulMs, phaseDurationsMs, queryCount, totalToolCalls, retryCount, tokenUsage, 'incomplete'));
  } catch (error) {
    if (config.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      activity.emit('aborted', { metrics: buildMetrics(config.model, startedAtMs, firstUsefulMs, phaseDurationsMs, queryCount, totalToolCalls, retryCount, tokenUsage, 'cancelled') });
      throw error;
    }
    activity.emit('error', { message: (error as Error).message, metrics: buildMetrics(config.model, startedAtMs, firstUsefulMs, phaseDurationsMs, queryCount, totalToolCalls, retryCount, tokenUsage, 'error') });
    throw error;
  }
}

async function streamModelResponse(
  client: AgentModelClient,
  model: string,
  messages: ModelChatMessage[],
  tools: ReturnType<ToolRegistry['getOpenAiTools']>,
  activity: ActivityManager,
  signal?: AbortSignal,
  effortLevel?: EffortLevel
): Promise<{
  content: string;
  toolCalls: ToolCallAccumulator[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
}> {
  let content = '';
  let reasoning = '';
  const toolCallMap = new Map<number, ToolCallAccumulator>();
  let finishReason: string | undefined;
  let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number } | undefined;

  try {
    const stream = client.streamChat({
      model,
      effortLevel,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: AGENT_DEFAULTS.temperature,
      maxTokens: AGENT_DEFAULTS.maxTokens,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(AGENT_DEFAULTS.modelCallTimeoutMs)])
    });

    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        if (reasoning.length < 200 || reasoning.length % 50 < 10) {
          activity.thinkingDelta(chunk.reasoning);
        }
      }

      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;

      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          if (!toolCallMap.has(tc.index)) {
            toolCallMap.set(tc.index, {
              id: tc.id ?? '',
              type: 'function',
              function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? ''
              }
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
      finishReason,
      usage
    };
  } catch (error) {
    throw error;
  }
}

interface ToolCallAccumulator {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

async function executeToolAndRecord(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  toolContext: ToolContext,
  toolRegistry: ToolRegistry,
  activity: ActivityManager,
  conversation: ModelChatMessage[],
  allToolCalls: Array<{ query: string; purpose: string; result: unknown }>,
  artifacts: QueryResultArtifact[],
  artifactCatalog: Map<string, QueryResultArtifact>,
  phaseDurationsMs: Record<string, number>,
  onToolResult: (toolName: string, input: Record<string, unknown>, result: AgentToolResult) => void
): Promise<void> {
  const startTime = performance.now();
  activity.toolStart(toolName, input.purpose as string);

  toolContext.signal?.throwIfAborted();
  const result = await toolRegistry.execute(toolName, input, toolContext);
  toolContext.signal?.throwIfAborted();
  const elapsedMs = Math.round(performance.now() - startTime);
  phaseDurationsMs.tools = (phaseDurationsMs.tools ?? 0) + elapsedMs;
  onToolResult(toolName, input, result);

  const { artifact, ...modelResult } = result;
  const toolMessage: ModelChatMessage = {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(modelResult)
  };
  conversation.push(toolMessage);

  activity.toolComplete(toolName, result.summary);

  allToolCalls.push({
    query: (input.query as string) ?? JSON.stringify(input),
    purpose: (input.purpose as string) ?? toolName,
    result
  });

  if (artifact && toolName === 'run_database_query') {
    const resultId = typeof result.data?.resultId === 'string' ? result.data.resultId : `${toolContext.turnId}-query-${artifacts.length + 1}`;
    const queryArtifact: QueryResultArtifact = {
      kind: 'query-result',
      queryId: resultId,
      query: (input.query as string) ?? '',
      purpose: (input.purpose as string) ?? toolName,
      result: artifact
    };
    artifacts.push(queryArtifact);
    artifactCatalog.set(queryArtifact.queryId, queryArtifact);
    activity.result(queryArtifact);
  }

  toolContext.controller.audit({
    turnId: toolContext.turnId,
    connectionId: toolContext.controller.getConnectionId(),
    toolName,
    toolInput: input,
    permissionDecision: 'allow',
    queryPreview: (input.query as string) ?? undefined,
    elapsedMs
  });
}

function buildResult(
  activity: ActivityManager,
  toolCalls: Array<{ query: string; purpose: string; result: unknown }>,
  artifacts: QueryResultArtifact[],
  content: string,
  metrics: TurnMetrics
): TurnResult {
  return {
    message: {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      metrics,
      createdAt: new Date().toISOString()
    },
    events: activity.getEvents(),
    artifacts,
    toolCalls,
    metrics
  };
}

function accumulateUsage(total: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number }): void {
  if (!usage) return;
  total.inputTokens += usage.promptTokens ?? 0;
  total.outputTokens += usage.completionTokens ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  total.costUsd += usage.costUsd ?? 0;
}

function buildMetrics(model: string, startedAtMs: number, firstUsefulMs: number | undefined, phaseDurationsMs: Record<string, number>, queryCount: number, toolCallCount: number, retryCount: number, usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }, terminalReason: TurnMetrics['terminalReason']): TurnMetrics {
  const completedAtMs = Date.now();
  return {
    promptVersion: AGENT_PROMPT_VERSION,
    model,
    startedAtMs,
    firstUsefulMs,
    completedAtMs,
    totalMs: completedAtMs - startedAtMs,
    phaseDurationsMs,
    queryCount,
    toolCallCount,
    retryCount,
    ...(usage.inputTokens ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.costUsd ? { costUsd: usage.costUsd } : {}),
    terminalReason
  };
}

function hydrateValidatedStructuredOutput(content: string, toolCalls: Array<{ result: unknown }>): string {
  const allowed = new Map<string, 'blocks' | 'chart'>();
  for (const call of toolCalls) {
    const result = call.result as AgentToolResult | undefined;
    if (!result?.ok || !result.data) continue;
    if (Array.isArray(result.data.blocks)) allowed.set(canonicalJson(result.data.blocks), 'blocks');
    if (typeof result.data.chartType === 'string') allowed.set(canonicalJson(result.data), 'chart');
  }
  const included: string[] = [];
  let removed = false;
  const fenced = content.replace(/```(?:blocks|chart)\s*\n([\s\S]*?)```/gi, (fence, payload: string) => {
    try {
      const canonical = canonicalJson(JSON.parse(payload.trim()));
      if (allowed.has(canonical)) {
        if (!included.includes(canonical)) included.push(canonical);
        return '';
      }
    } catch { /* Invalid or incomplete structured output is omitted. */ }
    removed = true;
    return '';
  });
  const unterminated = fenced.replace(/```(?:blocks|chart)\b[\s\S]*$/gi, () => {
    removed = true;
    return '';
  });
  const raw = stripRawStructuredJson(unterminated);
  removed ||= raw.removed;
  const sanitized = raw.content.trim();
  if (allowed.size === 0) return `${sanitized}${sanitized ? '\n\n' : ''}${removed ? 'Structured output was omitted because it was not backed by a verified result.' : ''}`.trim();
  // Downloads must survive even when the model fences only a companion chart.
  // Other omitted charts remain omitted so a chart repeated inside a report is
  // not also appended as a standalone duplicate.
  const requiredDownloads = [...allowed.keys()].filter(payload => {
    if (included.includes(payload) || allowed.get(payload) !== 'blocks') return false;
    try { return (JSON.parse(payload) as unknown[]).some(block => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'download'); }
    catch { return false; }
  });
  const payloads = included.length > 0 ? [...included, ...requiredDownloads] : [...allowed.keys()];
  const hydrated = payloads.map((payload) => `\`\`\`${allowed.get(payload)!}\n${payload}\n\`\`\``).join('\n\n');
  return `${sanitized}${sanitized ? '\n\n' : ''}${hydrated}`;
}

function stripRawStructuredJson(content: string): { content: string; removed: boolean } {
  let result = '';
  let cursor = 0;
  let removed = false;
  while (cursor < content.length) {
    const starts = [content.indexOf('{', cursor), content.indexOf('[', cursor)].filter((index) => index >= 0);
    if (starts.length === 0) return { content: result + content.slice(cursor), removed };
    const start = Math.min(...starts);
    const end = findJsonEnd(content, start);
    if (end === null) {
      result += content.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    const candidate = content.slice(start, end);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (containsStructuredDataBlock(parsed)) {
        result += content.slice(cursor, start);
        cursor = end;
        removed = true;
        continue;
      }
    } catch { /* Preserve ordinary prose containing braces. */ }
    result += content.slice(cursor, start + 1);
    cursor = start + 1;
  }
  return { content: result, removed };
}

function containsStructuredDataBlock(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => item && typeof item === 'object' && (
    ['table', 'chart', 'kpi', 'download'].includes(String((item as Record<string, unknown>).type))
    || typeof (item as Record<string, unknown>).chartType === 'string'
  ));
}

function findJsonEnd(source: string, start: number): number | null {
  const first = source[start];
  const stack = [first === '[' ? ']' : '}'];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') stack.push(']');
    else if (character === '{') stack.push('}');
    else if (character === ']' || character === '}') {
      if (character !== stack.at(-1)) return null;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
