export interface ContentBlock {
  type: 'text' | 'heading' | 'table' | 'chart' | 'code' | 'list' | 'divider';
  [key: string]: unknown;
}

export interface ContentSegment {
  type: 'markdown' | 'blocks';
  content: string;
  blocks?: ContentBlock[];
}

export function splitContent(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /```blocks\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'markdown',
        content: content.slice(lastIndex, match.index)
      });
    }

    const jsonStr = match[1].trim();
    try {
      const blocks = JSON.parse(jsonStr) as ContentBlock[];
      segments.push({ type: 'blocks', content: jsonStr, blocks });
    } catch {
      segments.push({ type: 'markdown', content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'markdown',
      content: content.slice(lastIndex)
    });
  }

  return segments;
}
