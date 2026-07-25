import type { Tool } from '../types.js';

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
