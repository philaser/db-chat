import type { Tool } from '../types.js';

export const clarifyTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'ask_clarification',
      description: 'Return one typed clarification when plausible interpretations would materially change the analysis.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One concise question.' },
          choices: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5, description: 'Optional concise choices.' }
        },
        required: ['question'],
        additionalProperties: false
      }
    }
  },
  async execute(input) {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    const choices = Array.isArray(input.choices) ? input.choices.filter((choice): choice is string => typeof choice === 'string' && choice.trim().length > 0).map((choice) => choice.trim()) : undefined;
    if (!question || question.length > 500 || (choices && (choices.length < 2 || choices.length > 5))) {
      return { ok: false, summary: 'Provide one concise question and two to five optional choices.', error: 'Invalid clarification', data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true } };
    }
    return { ok: true, summary: 'Clarification required before analysis can continue.', data: { blocks: [{ type: 'clarification', question, ...(choices ? { choices } : {}) }] } };
  }
};
