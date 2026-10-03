import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredContent } from '../src/web/contentBlocks.js';
import type { ContentBlock } from '../src/web/contentBlocks.js';

vi.mock('../src/web/chartRenderer.js', () => ({
  ChartViewMemo: ({ block }: { block: ContentBlock }) => <output aria-label="Rendered measures">{JSON.stringify(block.valueKeys)}</output>
}));
afterEach(cleanup);

describe('saved chart comparisons', () => {
  it('preserves all comparison measures until the user chooses one', () => {
    render(<StructuredContent blocks={[{ type: 'chart', chartType: 'line', columns: ['month', 'gross', 'net'], rows: [{ month: 'January', gross: 120, net: 100 }], nameKey: 'month', valueKeys: ['gross', 'net'] }]} />);
    expect(screen.getByLabelText('Rendered measures')).toHaveTextContent('["gross","net"]');
    expect(screen.getByLabelText('Metric')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'net' } });
    expect(screen.getByLabelText('Rendered measures')).toHaveTextContent('["net"]');
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: '' } });
    expect(screen.getByLabelText('Rendered measures')).toHaveTextContent('["gross","net"]');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'pie' } });
    expect(screen.getByLabelText('Metric')).toHaveValue('gross');
    expect(screen.getByLabelText('Rendered measures')).toHaveTextContent('["gross"]');
  });
});
