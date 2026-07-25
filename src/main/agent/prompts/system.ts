import type { AgentMemory } from '../../../shared/types.js';

export function buildSystemPrompt(options: {
  schemaContext: string;
  schemaKind: string;
  memories: AgentMemory[];
  toolsSection: string;
}): string {
  const { schemaContext, schemaKind, memories, toolsSection } = options;

  return [
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
  ].filter(Boolean).join('\n');
}

export function buildCompactionPrompt(): string {
  return `Summarize the conversation so far, preserving:\n1. Key facts the user has shared about their data.\n2. Important results and insights from queries.\n3. The user's stated goals and questions.\n4. Any preferences or context the user has mentioned.\n\nBe concise. Focus on what matters for continuing the data analysis.`;
}

export function buildMemoryExtractionPrompt(): string {
  return `Extract 2-5 important facts from this conversation that would be useful to remember for future data analysis sessions. Focus on:\n- Schema details the user has mentioned\n- Domain knowledge about the data\n- User preferences (e.g., preferred format, common queries)\n- Insights the user found valuable\n\nReturn as a JSON array of objects with fields: content, category (schema/domain/preference/query/note), importance (1-10).`;
}
