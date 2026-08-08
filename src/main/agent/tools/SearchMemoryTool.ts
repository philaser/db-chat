import type { Tool } from '../types.js';

export const searchMemoryTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search for previously saved facts, preferences, and insights in persistent memory. Use this to recall what you know about the user\'s data, domain, and preferences.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term to find relevant memories.'
          },
          category: {
            type: 'string',
            description: 'Optional: filter by category (schema, domain, preference, query, note).',
            enum: ['schema', 'domain', 'preference', 'query', 'note']
          },
          minImportance: {
            type: 'number',
            description: 'Optional: minimum importance level (1-10). Only return memories at or above this level.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },

  async execute(input, context) {
    const { query, category, minImportance } = input as {
      query: string;
      category?: string;
      minImportance?: number;
    };

    const store = context.controller.getMemoryStore();
    let results = store.search(query);

    if (category) {
      results = results.filter((m) => m.category === category);
    }

    if (minImportance !== undefined) {
      results = results.filter((m) => m.importance >= minImportance);
    }

    if (results.length === 0) {
      return {
        ok: true,
        summary: 'No matching memories found.',
        data: { memories: [], count: 0 }
      };
    }

    return {
      ok: true,
      summary: `Found ${results.length} matching memory/memories`,
      data: {
        memories: results.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          importance: m.importance,
          createdAt: m.createdAt,
          lastAccessedAt: m.lastAccessedAt
        })),
        count: results.length
      }
    };
  }
};