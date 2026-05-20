import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import type { DbChatApi } from '../src/shared/types';

function makeApi(): DbChatApi {
  return {
    chooseSqliteFile: vi.fn(),
    connect: vi.fn(),
    getSchema: vi.fn(),
    validateQuery: vi.fn(async (query) => ({
      safe: !/drop/i.test(query),
      reason: /drop/i.test(query) ? 'SAFE mode blocks statements that can change database state.' : 'Read-only query allowed by SAFE mode.',
      normalizedQuery: query
    })),
    executeQuery: vi.fn(async () => ({
      columns: ['name'],
      rows: [{ name: 'Ada' }],
      rowCount: 1,
      elapsedMs: 1
    })),
    sendChat: vi.fn(async () => ({
      message: {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: 'Try this query.',
        createdAt: new Date().toISOString()
      },
      generatedQuery: {
        query: 'select name from users;',
        explanation: 'Generated test query.',
        validation: {
          safe: true,
          reason: 'Read-only query allowed by SAFE mode.',
          normalizedQuery: 'select name from users;'
        }
      }
    })),
    loadSettings: vi.fn(async () => ({
      provider: 'openrouter' as const,
      model: 'openai/gpt-4.1-mini',
      safeMode: true,
      hasApiKey: false
    })),
    saveSettings: vi.fn(),
    saveApiKey: vi.fn(),
    listModels: vi.fn(async (provider: 'openrouter' | 'openai') => (
      provider === 'openrouter'
        ? [{ id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1 Mini' }]
        : [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' }]
    ))
  };
}

describe('App', () => {
  it('places generated SQL in the query pane and renders result rows', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask about the connected database...'), {
      target: { value: 'show users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    const editor = await screen.findByDisplayValue('select name from users;');
    expect(editor).toBeInTheDocument();

    fireEvent.click(screen.getByText('Run Safe Query'));
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
  });

  it('shows blocked validation for unsafe SQL', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Generated SQL will appear here.'), {
      target: { value: 'drop table users;' }
    });

    await waitFor(() => {
      expect(screen.getByText('SAFE mode blocks statements that can change database state.')).toBeInTheDocument();
    });
  });

  it('loads models in settings and confirms API key save', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Open settings'));
    expect(await screen.findByText('OpenAI GPT-4.1 Mini')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'test-key' }
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.saveApiKey).toHaveBeenCalledWith('openrouter', 'test-key');
      expect(screen.getByText('API key saved successfully.')).toBeInTheDocument();
    });
  });
});
