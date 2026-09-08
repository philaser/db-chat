import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredContent, parseContentBlocks, splitContent } from '../src/web/contentBlocks.js';

const tablePayload = JSON.stringify([{
  type: 'table',
  columns: ['Customer', 'Orders', 'Total Spent'],
  columnTypes: { Orders: 'number', 'Total Spent': 'number' },
  rows: [
    { Customer: 'Terhi Hämäläinen', Orders: 1, 'Total Spent': 13.86 },
    { Customer: 'Madalena Sampaio', Orders: 1, 'Total Spent': 8.91 }
  ]
}]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web content blocks', () => {
  it('recognizes table blocks in a JSON payload', () => {
    expect(parseContentBlocks(tablePayload)?.[0]).toMatchObject({ type: 'table', columns: ['Customer', 'Orders', 'Total Spent'] });
  });

  it('recognizes chart specifications returned by the visualization tool', () => {
    const chartPayload = JSON.stringify({
      chartType: 'bar',
      columns: ['month', 'orders'],
      rows: [{ month: 'November', orders: 7 }],
      nameKey: 'month',
      valueKeys: ['orders']
    });
    const chart = parseContentBlocks(chartPayload);
    expect(chart?.[0]).toMatchObject({ type: 'chart', chartType: 'bar', valueKeys: ['orders'] });
    expect(splitContent(`Chart:\n\n\`\`\`chart\n${chartPayload}\n\`\`\``).map((segment) => segment.type)).toEqual(['markdown', 'blocks']);
  });

  it('extracts raw table JSON while preserving surrounding Markdown', () => {
    const segments = splitContent(`Here is the breakdown:\n\n${tablePayload}\n\nThat is the full result.`);
    expect(segments.map((segment) => segment.type)).toEqual(['markdown', 'blocks', 'markdown']);
    expect(segments[1].blocks?.[0].type).toBe('table');
  });

  it('renders structured table blocks as a readable table', () => {
    const blocks = parseContentBlocks(tablePayload);
    render(<StructuredContent blocks={blocks!} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Total Spent' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Terhi Hämäläinen' })).toBeInTheDocument();
    expect(screen.queryByText(tablePayload)).not.toBeInTheDocument();
  });

  it('renders every supported chart type inside the editorial content surface', () => {
    const chartTypes = ['bar', 'line', 'area', 'pie', 'scatter', 'radar', 'radialBar', 'composed', 'funnel', 'treemap', 'sunburst', 'slope'] as const;
    const blocks = chartTypes.map((chartType) => ({
      type: 'chart' as const,
      chartType,
      columns: ['category', 'first', 'second'],
      rows: [
        { category: 'A', first: 1, second: 2 },
        { category: 'B', first: 3, second: 4 }
      ],
      nameKey: 'category',
      valueKeys: chartType === 'scatter' || chartType === 'slope' ? ['first', 'second'] : chartType === 'pie' || chartType === 'radialBar' || chartType === 'funnel' ? ['first'] : ['first', 'second']
    }));

    const { container } = render(<StructuredContent blocks={blocks} />);
    expect(Array.from(container.querySelectorAll('.assistant-chart')).map((node) => node.getAttribute('data-chart-type'))).toEqual(chartTypes);
    expect(container.querySelectorAll('.assistant-chart-error')).toHaveLength(0);
  });

  it('observes reduced-motion preference for chart animation', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    });
    vi.stubGlobal('matchMedia', matchMedia);

    const { unmount } = render(<StructuredContent blocks={[{
      type: 'chart',
      chartType: 'bar',
      columns: ['category', 'value'],
      rows: [{ category: 'A', value: 1 }],
      nameKey: 'category',
      valueKeys: ['value']
    }]} />);

    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('hides incomplete structured JSON until the block is complete', () => {
    const segments = splitContent('Working\n\n{"type":"chart","columns":["month"],"rows":[');
    expect(segments.map((segment) => segment.type)).toEqual(['markdown', 'pending']);
    expect(segments.at(-1)?.content).not.toBe('');
  });

  it('renders evidence-bound KPI and clarification blocks without arbitrary markup', () => {
    const selected: string[] = [];
    const listener = (event: Event) => selected.push((event as CustomEvent<string>).detail);
    window.addEventListener('dbchat:clarification', listener);
    render(<StructuredContent blocks={[
      { type: 'kpi', label: 'Revenue', value: 1200, unit: 'USD', resultId: 'result-1' },
      { type: 'clarification', question: 'Which definition?', choices: ['Gross', 'Net'] }
    ]} />);
    expect(screen.getByLabelText('Revenue: 1200')).toHaveTextContent('1200 USD');
    fireEvent.click(screen.getByRole('button', { name: 'Net' }));
    expect(selected).toEqual(['Net']);
    window.removeEventListener('dbchat:clarification', listener);
  });

  it('renders boolean and unavailable KPI values without rejecting the block payload', () => {
    const blocks = parseContentBlocks(JSON.stringify([
      { type: 'kpi', label: 'Active', value: true, resultId: 'result-1' },
      { type: 'kpi', label: 'Margin', value: null, unit: '%', resultId: 'result-1' }
    ]));
    expect(blocks).not.toBeNull();
    render(<StructuredContent blocks={blocks!} />);
    expect(screen.getByLabelText('Active: true')).toHaveTextContent('true');
    expect(screen.getByLabelText('Margin: —')).toHaveTextContent('—');
    expect(screen.getByLabelText('Margin: —')).not.toHaveTextContent('%');
  });

  it('labels bounded table and chart evidence with its visible coverage', () => {
    render(<StructuredContent blocks={[
      { type: 'table', columns: ['customer_name'], rows: [{ customer_name: 'Ada' }], coverage: { returnedRowCount: 1, loadedRowCount: 100, totalRowCount: 100, truncated: false } },
      { type: 'chart', chartType: 'bar', columns: ['customer_name', 'order_count'], rows: [{ customer_name: 'Ada', order_count: 1 }], coverage: { returnedRowCount: 1, loadedRowCount: 1, totalRowCount: null, truncated: true } }
    ]} />);
    expect(screen.getByRole('columnheader', { name: 'Customer Name' })).toHaveAttribute('title', 'customer_name');
    expect(screen.getByRole('option', { name: 'Customer Name' })).toHaveValue('customer_name');
    expect(screen.getAllByRole('option', { name: 'Order Count' }).every((option) => (option as HTMLOptionElement).value === 'order_count')).toBe(true);
    expect(screen.getByText('Showing 1 of 100 rows')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 loaded row; source result was limited')).toBeInTheDocument();
  });
});
