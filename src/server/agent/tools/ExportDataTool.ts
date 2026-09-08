import { classifyQuery } from '../../connectors/QueryValidator.js';
import type { Tool } from '../types.js';

const FORMATS = new Set(['csv', 'xlsx', 'json']);

export const exportDataTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'export_data',
      description: 'Start a raw data download without sending rows through the model. Export an owned resultId to rerun its exact query without the chat preview limit, or provide an explicit read-only query for the underlying matching records. Never derive a raw-record query by removing GROUP BY, aggregation, or LIMIT from another query.',
      parameters: {
        type: 'object',
        properties: {
          resultId: { type: 'string', description: 'Owned result ID whose exact query should be rerun for the complete export.' },
          query: { type: 'string', description: 'Explicit read-only query selecting the raw records to export. Use only when the requested records differ from an existing aggregate result.' },
          format: { type: 'string', enum: ['csv', 'xlsx', 'json'] },
          title: { type: 'string', description: 'Short filename-friendly description of the data.' }
        },
        required: ['format', 'title'],
        additionalProperties: false
      }
    }
  },
  async execute(input, context) {
    const resultId = typeof input.resultId === 'string' ? input.resultId.trim() : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const format = typeof input.format === 'string' ? input.format.toLowerCase() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if ((!resultId && !query) || (resultId && query)) return invalid('Provide exactly one of resultId or query.');
    if (!FORMATS.has(format)) return invalid('Export format must be csv, xlsx, or json.');
    if (!title || title.length > 200) return invalid('Provide an export title of 1 to 200 characters.');
    if (resultId && !context.resolveArtifact?.(resultId)) {
      return { ok: false, summary: 'Result not found in this chat.', error: `Unknown or unauthorized resultId: ${resultId}`, data: { errorCode: 'RESULT_NOT_FOUND', retryable: false } };
    }
    if (query && classifyQuery(query) !== 'read') return invalid('The export query must be a read-only SELECT or WITH query.');
    if (!context.requestExport) return unavailable('Data downloads are unavailable in this environment.');
    try {
      const job = await context.requestExport({
        ...(resultId ? { resultId } : { query }),
        format: format as 'csv' | 'xlsx' | 'json',
        title
      });
      const download = { type: 'download', exportId: job.id, title: job.title, format: job.format };
      return { ok: true, summary: `Started ${format.toUpperCase()} export "${title}".`, data: { blocks: [download], exportStatus: job.status } };
    } catch (error) {
      return { ok: false, summary: 'The data export could not be started.', error: error instanceof Error ? error.message : 'Export failed', data: { errorCode: 'EXPORT_FAILED', retryable: true } };
    }
  }
};

function invalid(summary: string) {
  return { ok: false as const, summary, error: summary, data: { errorCode: 'INVALID_TOOL_INPUT', retryable: true } };
}

function unavailable(summary: string) {
  return { ok: false as const, summary, error: summary, data: { errorCode: 'EXPORT_UNAVAILABLE', retryable: false } };
}
