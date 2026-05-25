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
    )),
    listChatSessions: vi.fn(async () => []),
    saveChatSession: vi.fn(async (session) => session),
    deleteChatSession: vi.fn(),
    listConnections: vi.fn(async () => []),
    deleteConnection: vi.fn()
  };
}

describe('App', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('places generated SQL in the query inspector and renders automatic result rows', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask about the connected database...'), {
      target: { value: 'show users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect(await screen.findByLabelText('Data results')).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Chat')).queryByText(/select name from users;/)).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByLabelText('Inspector')).getByRole('button', { name: 'Query' }));
    expect(await screen.findByDisplayValue('select name from users;')).toBeInTheDocument();
    expect(api.sendChat).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'show users' })
    ]));
    await waitFor(() => {
      expect(api.saveChatSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'show users',
        query: 'select name from users;',
        result: expect.objectContaining({ rowCount: 1 })
      }));
    });
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

    fireEvent.click(within(screen.getByLabelText('Inspector')).getByRole('button', { name: 'Query' }));
    fireEvent.change(screen.getByPlaceholderText('Generated SQL will appear here.'), {
      target: { value: 'drop table users;' }
    });

    await waitFor(() => {
      expect(screen.getByText('SAFE mode blocks statements that can change database state.')).toBeInTheDocument();
    });
  });

  it('switches theme modes and persists the selection', () => {
    const api = makeApi();
    const { container } = render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Settings'));

    const themeSelects = container.querySelectorAll<HTMLSelectElement>('select.theme-select');
    expect(themeSelects).toHaveLength(2);
    const [lightSelect, darkSelect] = themeSelects;

    fireEvent.change(lightSelect, { target: { value: 'catppuccin-latte' } });
    expect(document.documentElement.dataset.theme).toBe('catppuccin-latte');
    expect(window.localStorage.getItem('dbchat:theme')).toBe('catppuccin-latte');

    fireEvent.change(darkSelect, { target: { value: 'nord' } });
    expect(document.documentElement.dataset.theme).toBe('nord');
    expect(window.localStorage.getItem('dbchat:theme')).toBe('nord');

    fireEvent.change(lightSelect, { target: { value: 'light' } });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('dbchat:theme')).toBe('light');

    fireEvent.change(darkSelect, { target: { value: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('dbchat:theme')).toBe('dark');
  });

  it('keeps the workspace rail fixed and collapses the resizable inspector', () => {
    const api = makeApi();
    render(<App api={api} />);

    const shell = screen.getByRole('main');
    const chat = screen.getByLabelText('Chat');
    expect(within(chat).queryByLabelText('Collapse workspace sidebar')).not.toBeInTheDocument();
    expect(within(chat).queryByLabelText('Collapse inspector sidebar')).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize workspace sidebar' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Collapse workspace sidebar')).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize inspector sidebar' }), {
      key: 'ArrowLeft'
    });
    expect(shell.style.getPropertyValue('--left-panel-width')).toBe('74px');
    expect(shell.style.getPropertyValue('--right-panel-width')).toBe('404px');

    fireEvent.click(screen.getByLabelText('Collapse inspector sidebar'));
    expect(screen.queryByLabelText('Inspector')).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize inspector sidebar' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Expand inspector sidebar')).toBeInTheDocument();
  });

  it('uses DB-focused starter prompts to populate the composer', () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByRole('button', { name: /Summarize this database/i }));

    expect(screen.getByPlaceholderText('Ask about the connected database...')).toHaveValue(
      'Summarize the connected database and suggest the most useful questions to ask next.'
    );
  });

  it('lets the inspector switch tabs and selects results after a manual safe query', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(within(screen.getByLabelText('Inspector')).getByRole('button', { name: 'Query' }));
    fireEvent.change(screen.getByPlaceholderText('Generated SQL will appear here.'), {
      target: { value: 'select name from users;' }
    });

    await waitFor(() => {
      expect(screen.getByText('Read-only query allowed by SAFE mode.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run Safe Query' }));

    expect(await screen.findByLabelText('Data results')).toBeInTheDocument();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(api.executeQuery).toHaveBeenCalledWith('select name from users;', 'safe');
  });

  it('loads chat and connection histories, restores sessions, and deletes history items', async () => {
    const api = makeApi();
    const connection = {
      id: 'connection-1',
      kind: 'sqlite' as const,
      label: 'customers.db',
      databasePath: '/tmp/customers.db',
      createdAt: '2026-05-01T00:00:00.000Z'
    };
    const sessions = [{
      id: 'session-1',
      title: 'Top customers',
      messages: [
        {
          id: 'user-1',
          role: 'user' as const,
          content: 'show top customers',
          createdAt: '2026-05-02T00:00:00.000Z'
        },
        {
          id: 'assistant-history',
          role: 'assistant' as const,
          content: 'Ada is the top customer.',
          createdAt: '2026-05-02T00:00:01.000Z'
        }
      ],
      connection,
      query: 'select name from customers;',
      result: {
        columns: ['name'],
        rows: [{ name: 'Ada' }],
        rowCount: 1,
        elapsedMs: 2
      },
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:01.000Z'
    }];
    const connections = [{
      ...connection,
      lastConnectedAt: '2026-05-03T00:00:00.000Z'
    }];
    vi.mocked(api.listChatSessions).mockImplementation(async () => sessions);
    vi.mocked(api.listConnections).mockImplementation(async () => connections);
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'sqlite',
      label: 'customers.db',
      tables: [{ name: 'customers', columns: [] }]
    });

    render(<App api={api} />);

    fireEvent.click(await screen.findByLabelText('Recent chats'));
    expect(await screen.findByText('Top customers')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Top customers'));

    expect(await screen.findByText('Ada is the top customer.')).toBeInTheDocument();
    expect(api.connect).toHaveBeenCalledWith(connection);

    fireEvent.click(screen.getByLabelText('Recent chats'));
    fireEvent.click(screen.getByText('All history'));
    fireEvent.click(screen.getByLabelText('Delete chat Top customers'));
    await waitFor(() => {
      expect(api.deleteChatSession).toHaveBeenCalledWith('session-1');
      expect(screen.getByText('Chat deleted')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Connections'));
    expect((await screen.findAllByText('customers.db')).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByLabelText('Delete connection customers.db'));
    expect(api.deleteConnection).toHaveBeenCalledWith('connection-1');
  });

  it('connects to Elasticsearch from the connections view', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'elasticsearch',
      label: 'localhost',
      tables: [{ name: 'orders', columns: [{ name: 'customer', type: 'keyword', nullable: true, primaryKey: false }] }]
    });
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Connections'));
    fireEvent.click(screen.getByRole('button', { name: 'Elasticsearch' }));
    expect(within(screen.getByLabelText('Elasticsearch connection')).queryByText('API key')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'elastic.internal' }
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '9243' }
    });
    fireEvent.click(screen.getByLabelText('Remember password'));
    fireEvent.click(within(screen.getByLabelText('Elasticsearch connection')).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'elasticsearch',
        label: 'elastic.internal:9243',
        elasticsearchHost: 'elastic.internal',
        elasticsearchPort: 9243,
        elasticsearchUseSsl: false,
        elasticsearchVerifyCerts: true,
        elasticsearchRememberPassword: true
      }));
    });
    expect(await screen.findByText('orders')).toBeInTheDocument();
  });

  it('reopens saved Elasticsearch history for password entry before reconnecting', async () => {
    const api = makeApi();
    vi.mocked(api.listConnections).mockResolvedValue([{
      id: 'elastic-history',
      kind: 'elasticsearch',
      label: 'elastic.internal:9243',
      elasticsearchHost: 'elastic.internal',
      elasticsearchPort: 9243,
      elasticsearchUseSsl: true,
      elasticsearchVerifyCerts: false,
      elasticsearchUsername: 'elastic-user',
      createdAt: '2026-05-21T00:00:00.000Z',
      lastConnectedAt: '2026-05-21T00:00:00.000Z'
    }]);
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Connections'));
    fireEvent.click(await screen.findByText('elastic.internal:9243'));

    expect(await screen.findByText('Enter the password to reconnect elastic.internal:9243.')).toBeInTheDocument();
    expect(screen.getByLabelText('Host')).toHaveValue('elastic.internal');
    expect(screen.getByLabelText('Port')).toHaveValue(9243);
    expect(screen.getByLabelText('Username')).toHaveValue('elastic-user');
    expect(screen.getByLabelText('Use HTTPS')).toBeChecked();
    expect(screen.getByLabelText('Verify TLS certificates')).not.toBeChecked();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('reconnects Elasticsearch history directly when a password was remembered', async () => {
    const api = makeApi();
    const connection = {
      id: 'elastic-remembered',
      kind: 'elasticsearch' as const,
      label: 'elastic.internal:9243',
      elasticsearchHost: 'elastic.internal',
      elasticsearchPort: 9243,
      elasticsearchUseSsl: true,
      elasticsearchVerifyCerts: true,
      elasticsearchUsername: 'elastic-user',
      elasticsearchRememberPassword: true,
      elasticsearchHasSavedPassword: true,
      createdAt: '2026-05-21T00:00:00.000Z',
      lastConnectedAt: '2026-05-21T00:00:00.000Z'
    };
    vi.mocked(api.listConnections).mockResolvedValue([connection]);
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'elasticsearch',
      label: connection.label,
      tables: []
    });
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Connections'));
    fireEvent.click(await screen.findByText('elastic.internal:9243'));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(connection);
    });
    expect(screen.queryByLabelText('Elasticsearch connection')).not.toBeInTheDocument();
  });

  it('shows safe connection errors and keeps diagnostic detail in logs', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'dbchat:connect': Error: Could not reach Elasticsearch at https://elastic.internal:9243: self-signed certificate"
    ));
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Connections'));
    fireEvent.click(screen.getByRole('button', { name: 'Elasticsearch' }));
    fireEvent.click(within(screen.getByLabelText('Elasticsearch connection')).getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Could not connect to Elasticsearch.')).toBeInTheDocument();
    expect(screen.queryByText(/Could not reach Elasticsearch at https:\/\/elastic.internal:9243: self-signed certificate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Settings'));
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }));

    expect(await screen.findByText(/Could not reach Elasticsearch at https:\/\/elastic.internal:9243: self-signed certificate/)).toBeInTheDocument();
    expect(screen.getByText(/Error invoking remote method/)).toBeInTheDocument();
  });

  it('loads models in settings and confirms API key save', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Settings'));
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

    fireEvent.click(screen.getByLabelText('Settings'));
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
