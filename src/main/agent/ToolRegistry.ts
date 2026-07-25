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
