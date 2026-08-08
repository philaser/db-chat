import type { WebContents } from 'electron';
import type { ChatMessage, ModelChatMessage, AgentEvent, AgentToolResult } from '../../shared/types.js';
import { ToolRegistry } from './ToolRegistry.js';
import { ActivityManager } from './ActivityManager.js';
import { ContextManager } from './ContextManager.js';
import { MemoryStore } from './MemoryStore.js';
import { OpenRouterClient } from '../model/OpenRouterClient.js';
import { buildSystemPrompt } from './prompts/system.js';
import { AGENT_DEFAULTS, type ToolContext } from './types.js';
import { PermissionManager } from './PermissionManager.js';
import { ApprovalManager } from './ApprovalManager.js';
import type { IpcController } from '../ipc.js';

export interface AgentLoopConfig {
  model: string;
  client: OpenRouterClient;
  controller: IpcController;
  memoryStore: MemoryStore;
  toolRegistry: ToolRegistry;
  permissionManager: PermissionManager;
  approvalManager: ApprovalManager;
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

  const connector = config.controller.getConnector();
  const schema = await config.controller.getSchema();

  const toolContext: ToolContext = {
    turnId,
    controller: config.controller,
    connector,
    schema,
    emitEvent: (event) => activity.emit(event.type, event.data)
  };

  const schemaContext = connector
    ? await connector.getContextForPrompt()
    : 'No database connected.';

  const schemaKind = schema?.kind ?? 'sqlite';
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

  const userAssistantMessages = messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  );
  conversation.push(...userAssistantMessages);

  activity.status('Thinking...');

  let totalToolCalls = 0;
  const allToolCalls: Array<{ query: string; purpose: string; result: unknown }> = [];

  try {
    for (let round = 0; round < AGENT_DEFAULTS.maxTurnRounds; round++) {
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
        activity
      );

      if (modelResponse.toolCalls.length === 0) {
        return buildResult(
          activity,
          allToolCalls,
          modelResponse.content || 'I analyzed the data but could not produce a result.'
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

      let pendingCalls = modelResponse.toolCalls.slice(0, AGENT_DEFAULTS.maxParallelTools);
      if (totalToolCalls + pendingCalls.length > AGENT_DEFAULTS.maxTotalToolCalls) {
        pendingCalls = pendingCalls.slice(
          0,
          AGENT_DEFAULTS.maxTotalToolCalls - totalToolCalls
        );
      }

      for (const call of pendingCalls) {
        const toolName = call.function.name;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          input = {};
        }

        const permission = config.permissionManager.check(toolName, input);

        if (permission === 'deny') {
          const currentLevel = config.permissionManager.getSafetyLevel();
          const denyResult: AgentToolResult = {
            ok: false,
            summary: `Blocked by safety level "${currentLevel}". The user can switch to a higher safety level (elevated or unrestricted) in the composer footer to allow this operation.`,
            error: `Permission denied at safety level "${currentLevel}". Ask the user to switch to elevated or unrestricted mode if they want to proceed.`
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
            await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls);
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

          const approved = await config.approvalManager.waitForDecision(interruption.id);
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
            await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls);
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

        await executeToolAndRecord(toolName, input, call.id, toolContext, config.toolRegistry, activity, conversation, allToolCalls);
        totalToolCalls++;
      }
    }

    activity.status('Wrapping up analysis...');
    return buildResult(activity, allToolCalls, 'Analysis complete.');
  } catch (error) {
    activity.error((error as Error).message);
    return buildResult(
      activity,
      allToolCalls,
      `An error occurred: ${(error as Error).message}`
    );
  }
}

async function streamModelResponse(
  client: OpenRouterClient,
  model: string,
  messages: ModelChatMessage[],
  tools: ReturnType<ToolRegistry['getOpenAiTools']>,
  activity: ActivityManager
): Promise<{
  content: string;
  toolCalls: ToolCallAccumulator[];
}> {
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
      toolCalls: Array.from(toolCallMap.values())
    };
  } catch (error) {
    activity.error((error as Error).message);
    return { content, toolCalls: [] };
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
  allToolCalls: Array<{ query: string; purpose: string; result: unknown }>
): Promise<void> {
  const startTime = performance.now();
  activity.toolStart(toolName, input.purpose as string);

  const result = await toolRegistry.execute(toolName, input, toolContext);
  const elapsedMs = Math.round(performance.now() - startTime);

  // Refresh schema after successful DDL so subsequent tool calls see the updated structure
  if (toolName === 'run_database_query' && result.ok) {
    const query = (input.query as string) ?? '';
    const isDDL = /^\s*(CREATE|DROP|ALTER|TRUNCATE|RENAME|GRANT|REVOKE)\s/i.test(query.trim());
    if (isDDL && toolContext.connector) {
      try {
        const freshSchema = await toolContext.controller.refreshSchema();
        if (freshSchema) {
          toolContext.schema = freshSchema;
          activity.status('Schema refreshed after DDL operation');
        }
      } catch {
        // Non-critical — the DDL itself succeeded
      }
    }
  }

  const toolMessage: ModelChatMessage = {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(result)
  };
  conversation.push(toolMessage);

  activity.toolComplete(toolName, result.summary);

  allToolCalls.push({
    query: (input.query as string) ?? JSON.stringify(input),
    purpose: (input.purpose as string) ?? toolName,
    result
  });

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
  content: string
): TurnResult {
  return {
    message: {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString()
    },
    events: activity.getEvents(),
    toolCalls
  };
}
