import type { ModelChatMessage, AgentMemory } from '../../shared/types.js';
import { DEFAULT_COMPACT_CONFIG, type CompactConfig, type ContextSnapshot } from './types.js';
import type { OpenRouterClient } from '../model/OpenRouterClient.js';
import { buildCompactionPrompt } from './prompts/system.js';

export class ContextManager {
  constructor(
    private client: OpenRouterClient,
    private model: string,
    private config: CompactConfig = DEFAULT_COMPACT_CONFIG
  ) {}

  estimateTokens(messages: ModelChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4;
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 3.5);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += Math.ceil(tc.function.name.length / 3);
          total += Math.ceil(tc.function.arguments.length / 3);
        }
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
      let summary = '';
      const stream = this.client.streamChat({
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
