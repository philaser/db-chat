import type { WebContents } from 'electron';
import type { ChatMessage, ModelChatMessage, AgentEvent } from '../../shared/types';
import { ToolRegistry } from './ToolRegistry';
import { ActivityManager } from './ActivityManager';
import { ContextManager } from './ContextManager';
import { MemoryStore } from './MemoryStore';
import { OpenRouterClient } from '../model/OpenRouterClient';
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
