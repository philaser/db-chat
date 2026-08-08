import type { Tool } from '../types.js';

export const exportReportTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'export_report',
      description: 'Format analysis results into a structured report that the user can copy or download. Use this when the user asks for a summary, report, or export of findings.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the report.'
          },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Section heading.' },
                body: { type: 'string', description: 'Section content (Markdown).' }
              },
              required: ['heading', 'body']
            },
            description: 'Array of report sections, each with a heading and body.'
          },
          format: {
            type: 'string',
            description: 'Output format: "markdown" (recommended) or "text".',
            enum: ['markdown', 'text']
          }
        },
        required: ['title', 'sections', 'format'],
        additionalProperties: false
      }
    }
  },

  async execute(input, _context) {
    const { title, sections, format } = input as {
      title: string;
      sections: Array<{ heading: string; body: string }>;
      format: string;
    };

    if (!sections || !Array.isArray(sections) || sections.length === 0) {
      return { ok: false, summary: 'No sections provided', error: 'Report must have at least one section' };
    }

    let report: string;

    if (format === 'markdown') {
      const header = `# ${title}\n\n`;
      const body = sections
        .map((s) => `## ${s.heading}\n\n${s.body}`)
        .join('\n\n');
      report = header + body;
    } else {
      const divider = '─'.repeat(60);
      const header = `${divider}\n  ${title}\n${divider}\n\n`;
      const body = sections
        .map((s) => `${s.heading}\n${'─'.repeat(s.heading.length)}\n${s.body}`)
        .join('\n\n');
      report = header + body;
    }

    const charCount = report.length;

    return {
      ok: true,
      summary: `Generated ${format} report: "${title}" (${sections.length} sections, ${charCount} characters)`,
      data: {
        title,
        format,
        sections: sections.map((s) => ({ heading: s.heading, wordCount: s.body.split(/\s+/).filter(Boolean).length })),
        characterCount: charCount,
        report
      }
    };
  }
};