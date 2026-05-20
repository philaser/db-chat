import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
        content: 'I found Ada in the users table.',
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
      },
      queryResult: {
        columns: ['name'],
        rows: [{ name: 'Ada' }],
        rowCount: 1,
        elapsedMs: 1
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
        ? [
          { id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1 Mini' },
          { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek V3.1' }
        ]
        : [{ id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' }]
    ))
  };
}

describe('App', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('places generated SQL in the query pane and renders automatic result rows', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask about the connected database...'), {
      target: { value: 'show users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    const editor = await screen.findByDisplayValue('select name from users;');
    expect(editor).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Chat')).queryByText(/select name from users;/)).not.toBeInTheDocument();
    expect(api.sendChat).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'show users' })
    ]));
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it('renders markdown in chat messages', async () => {
    const api = makeApi();
    vi.mocked(api.sendChat).mockResolvedValueOnce({
      message: {
        id: 'assistant-markdown',
        role: 'assistant' as const,
        content: '**Users**\n\n- `Ada`\n- Grace',
        createdAt: new Date().toISOString()
      }
    });
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask about the connected database...'), {
      target: { value: 'summarize users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect((await screen.findByText('Users')).tagName).toBe('STRONG');
    expect(screen.getByText('Ada').tagName).toBe('CODE');
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('shows a generating indicator while waiting for an answer and scrolls to new messages', async () => {
    const api = makeApi();
    let resolveChat: (value: Awaited<ReturnType<DbChatApi['sendChat']>>) => void = () => undefined;
    vi.mocked(api.sendChat).mockReturnValueOnce(new Promise((resolve) => {
      resolveChat = resolve;
    }));
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask about the connected database...'), {
      target: { value: 'show users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(await screen.findByLabelText('Generating answer')).toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    resolveChat({
      message: {
        id: 'assistant-done',
        role: 'assistant' as const,
        content: 'Done.',
        createdAt: new Date().toISOString()
      }
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Generating answer')).not.toBeInTheDocument();
      expect(screen.getByText('Done.')).toBeInTheDocument();
    });
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
    expect(await screen.findByDisplayValue('openai/gpt-4.1-mini')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'test-key' }
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(api.saveApiKey).toHaveBeenCalledWith('openrouter', 'test-key');
      expect(screen.getByText('API key saved successfully.')).toBeInTheDocument();
    });
  });

  it('filters and saves models from the searchable model field', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Open settings'));
    const modelInput = await screen.findByLabelText('Model name');
    fireEvent.change(modelInput, {
      target: { value: 'deep' }
    });

    expect(screen.getByText('DeepSeek V3.1')).toBeInTheDocument();

    fireEvent.change(modelInput, {
      target: { value: 'deepseek/deepseek-chat-v3.1' }
    });

    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
        model: 'deepseek/deepseek-chat-v3.1'
      }));
    });
  });
});
