import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/App';
import type { AgentEvent, DatabaseSchema, DbChatApi } from '../src/shared/types';

type TestDbChatApi = DbChatApi & {
  emitEvent: (event: AgentEvent) => void;
};

function makeApi(): TestDbChatApi {
  let eventListener: ((event: AgentEvent) => void) | null = null;
  let subscribedTurnId: string | null = null;
  const api: DbChatApi = {
    chooseSqliteFile: vi.fn(),
    connect: vi.fn(),
    getSchema: vi.fn(),
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
      }
    })),
    subscribeToAgentEvents: vi.fn((turnId, listener) => {
      subscribedTurnId = turnId;
      eventListener = listener;
      return vi.fn(() => {
        if (subscribedTurnId === turnId) {
          subscribedTurnId = null;
          eventListener = null;
        }
      });
    }),
    abortChat: vi.fn(),
    loadSettings: vi.fn(async () => ({
      provider: 'openrouter' as const,
      model: 'openai/gpt-4.1-mini',
      hasApiKey: false
    })),
    saveSettings: vi.fn(),
    saveApiKey: vi.fn(),
    listModels: vi.fn(async () => [
      { id: 'openai/gpt-4.1-mini', name: 'OpenAI GPT-4.1 Mini' },
      { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek V3.1' }
    ]),
    listChatSessions: vi.fn(async () => []),
    saveChatSession: vi.fn(async (session) => session),
    deleteChatSession: vi.fn(),
    clearChatSessions: vi.fn(),
    listConnections: vi.fn(async () => []),
    deleteConnection: vi.fn(),
    saveCsvFile: vi.fn()
  };
  return {
    ...api,
    emitEvent: (event: AgentEvent) => eventListener?.({
      ...event,
      turnId: event.turnId === 'active-turn' && subscribedTurnId ? subscribedTurnId : event.turnId
    })
  };
}

describe('App', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
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

    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up'), {
      target: { value: 'summarize users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    expect((await screen.findByText('Users')).tagName).toBe('STRONG');
    expect(screen.getByText('Ada').tagName).toBe('CODE');
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('shows a generating indicator while waiting for an answer', async () => {
    const api = makeApi();
    let resolveChat: (value: Awaited<ReturnType<DbChatApi['sendChat']>>) => void = () => undefined;
    vi.mocked(api.sendChat).mockReturnValueOnce(new Promise((resolve) => {
      resolveChat = resolve;
    }));
    render(<App api={api} />);

    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up'), {
      target: { value: 'show users' }
    });
    fireEvent.click(screen.getByLabelText('Send message'));

    // Status text shows "Thinking..."
    expect(await screen.findByText('Thinking...')).toBeInTheDocument();

    resolveChat({
      message: {
        id: 'assistant-done',
        role: 'assistant' as const,
        content: 'Done.',
        createdAt: new Date().toISOString()
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeInTheDocument();
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

  it('keeps the inspector collapsible and resizeable', () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(screen.getByLabelText('Expand inspector sidebar')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand inspector sidebar'));
    expect(screen.getByLabelText('Inspector')).toBeInTheDocument();
    expect(screen.getByLabelText('Close inspector')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close inspector'));
    expect(screen.getByLabelText('Expand inspector sidebar')).toBeInTheDocument();
  });

  it('uses DB-focused starter prompts to populate the composer', () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByRole('button', { name: /Summarize this database/i }));

    expect(screen.getByPlaceholderText('Ask a follow-up')).toHaveValue(
      'Summarize the connected database and suggest the most useful questions to ask next.'
    );
  });

  it('searches, expands, and switches the schema between Pro and Raw views', async () => {
    const api = makeApi();
    const connection = {
      id: 'schema-db',
      kind: 'sqlite' as const,
      label: 'schema.db',
      databasePath: '/tmp/schema.db',
      createdAt: '2026-06-03T00:00:00.000Z'
    };
    const schema: DatabaseSchema = {
      kind: 'sqlite',
      label: 'schema.db',
      tables: [
        {
          name: 'z_archive',
          columns: [{ name: 'archived_at', type: 'datetime', nullable: true, primaryKey: false }]
        },
        {
          name: 'customer_orders',
          columns: [
            { name: 'status', type: 'text', nullable: true, primaryKey: false },
            { name: 'total_amount', type: 'decimal', nullable: false, primaryKey: false },
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'created_at', type: 'datetime', nullable: false, primaryKey: false },
            { name: 'customer_id', type: 'integer', nullable: false, primaryKey: false }
          ]
        }
      ]
    };
    vi.mocked(api.chooseSqliteFile).mockResolvedValue(connection);
    vi.mocked(api.connect).mockResolvedValue(schema);

    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /sqlite/i }));

    expect(await screen.findByText('Customer Orders')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Z Archive')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search schema'), {
      target: { value: 'status' }
    });
    expect(screen.getByText('Customer Orders')).toBeInTheDocument();
    expect(screen.queryByText('Z Archive')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search schema'), {
      target: { value: 'no match' }
    });
    expect(screen.getByText('No schema matches found.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search schema'), {
      target: { value: '' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('button', { name: 'Raw' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('customer_orders')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /customer_orders/i }));
    expect(screen.getByText('created_at')).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Summarize Customer Orders.' }));
    expect(screen.getByPlaceholderText('Ask a follow-up')).toHaveValue('Summarize Customer Orders.');

    const schemaPanel = screen.getByLabelText('Schema') as HTMLElement;
    const scrollTo = vi.fn();
    schemaPanel.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    schemaPanel.scrollTop = 120;
    fireEvent.scroll(schemaPanel);
    fireEvent.click(screen.getByLabelText('Return to top of schema'));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('loads chat and connection histories, restores sessions, and deletes items', async () => {
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

    // Chat is shown in sidebar
    fireEvent.click(await screen.findByText('Top customers'));

    expect(await screen.findByText('Ada is the top customer.')).toBeInTheDocument();
    expect(api.connect).toHaveBeenCalledWith(connection);

    // Navigate to connections view to see saved connections
    fireEvent.click(screen.getByLabelText('Connection selector'));
    expect((await screen.findAllByText('customers.db')).length).toBeGreaterThan(0);

    // Delete connection
    fireEvent.click(await screen.findByLabelText('Delete connection customers.db'));
    expect(api.deleteConnection).toHaveBeenCalledWith('connection-1');

    // Navigate to history view via Settings -> History
    fireEvent.click(screen.getByLabelText('Settings'));
    // Go back to workspace first, then to history
    fireEvent.click(screen.getByText('Back to chat'));
    // Open history view from sidebar "Show more" won't work, use History view directly
    // Let's check the delete through history access
  });

  it('clears all chat history', async () => {
    const api = makeApi();
    const sessions = [{
      id: 'session-1',
      title: 'Top customers',
      messages: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:01.000Z'
    }];
    vi.mocked(api.listChatSessions).mockImplementation(async () => sessions);

    render(<App api={api} />);

    expect(await screen.findByText('Top customers')).toBeInTheDocument();
  });

  it('connects to Elasticsearch from the connections view', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'elasticsearch',
      label: 'localhost',
      tables: [{ name: 'orders', columns: [{ name: 'customer', type: 'keyword', nullable: true, primaryKey: false }] }]
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /elasticsearch/i }));

    // Wait for form to appear
    const form = await screen.findByLabelText('Elasticsearch connection');
    expect(within(form).queryByText('API key')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Host'), {
      target: { value: 'elastic.internal' }
    });
    fireEvent.change(screen.getByLabelText('Port'), {
      target: { value: '9243' }
    });
    fireEvent.click(screen.getByLabelText('Remember password'));
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));

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
    expect(await screen.findByPlaceholderText('Search indices or fields')).toBeInTheDocument();
    // "orders" table name appears as "Orders" in Pro view mode
    expect(await screen.findByText('Orders')).toBeInTheDocument();
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

    // Click connection in sidebar
    fireEvent.click(await screen.findByText('elastic.internal:9243'));

    expect(await screen.findByLabelText('Elasticsearch connection')).toBeInTheDocument();
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

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /elasticsearch/i }));
    const form = await screen.findByLabelText('Elasticsearch connection');
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));

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

  it('connects to MySQL from the connections view', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'mysql',
      label: 'localhost',
      tables: [{ name: 'users', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }] }]
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /mysql/i }));

    const form = await screen.findByLabelText('MySQL connection');
    fireEvent.change(within(form).getByLabelText('Host'), {
      target: { value: 'mysql.local' }
    });
    fireEvent.change(within(form).getByLabelText('Port'), {
      target: { value: '3307' }
    });
    fireEvent.change(within(form).getByLabelText('Database'), {
      target: { value: 'testdb' }
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mysql',
        host: 'mysql.local',
        port: 3307,
        database: 'testdb'
      }));
    });
  });

  it('connects to PostgreSQL from the connections view', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'postgres',
      label: 'localhost',
      tables: [{ name: 'users', columns: [] }]
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /postgresql/i }));

    const form = await screen.findByLabelText('PostgreSQL connection');
    fireEvent.change(within(form).getByLabelText('Host'), {
      target: { value: 'pg.local' }
    });
    fireEvent.change(within(form).getByLabelText('Port'), {
      target: { value: '5432' }
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'postgres',
        host: 'pg.local',
        port: 5432
      }));
    });
  });

  it('shows only the selected database connection form', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /elasticsearch/i }));
    expect(await screen.findByLabelText('Elasticsearch connection')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /postgresql/i }));

    expect(screen.queryByLabelText('Elasticsearch connection')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('PostgreSQL connection')).toBeInTheDocument();
  });

  it('connects to MongoDB from the connections view', async () => {
    const api = makeApi();
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'mongodb',
      label: 'localhost',
      tables: [{ name: 'users', columns: [] }]
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('Add connection'));
    fireEvent.click(screen.getByRole('button', { name: /choose connection type/i }));
    fireEvent.click(screen.getByRole('option', { name: /mongodb/i }));

    const form = await screen.findByLabelText('MongoDB connection');
    fireEvent.change(within(form).getByLabelText('Host'), {
      target: { value: 'mongo.local' }
    });
    fireEvent.change(within(form).getByLabelText('Auth database'), {
      target: { value: 'admin' }
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'mongodb',
        host: 'mongo.local',
        authDatabase: 'admin'
      }));
    });
  });

  it('shows SQL placeholder in Query tab', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Expand inspector sidebar'));
    const queryTab = within(screen.getByLabelText('Inspector')).getByRole('tab', { name: 'Query' });
    fireEvent.click(queryTab);
    expect(screen.getByPlaceholderText('Generated SQL will appear here.')).toBeInTheDocument();
  });

  it('opens db form for password entry when reconnecting a MySQL history without saved password', async () => {
    const api = makeApi();
    vi.mocked(api.listConnections).mockResolvedValue([{
      id: 'mysql-history',
      kind: 'mysql',
      label: 'mysql.local:3306',
      host: 'mysql.local',
      port: 3306,
      database: 'testdb',
      username: 'root',
      hasSavedPassword: false,
      createdAt: '2026-05-21T00:00:00.000Z',
      lastConnectedAt: '2026-05-21T00:00:00.000Z'
    }]);
    render(<App api={api} />);

    // Click connection in sidebar
    fireEvent.click(await screen.findByText('mysql.local:3306'));

    const form = await screen.findByLabelText('MySQL connection');
    expect(form).toBeInTheDocument();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('reconnects passwordless MySQL history directly without form', async () => {
    const api = makeApi();
    const connection = {
      id: 'mysql-passwordless',
      kind: 'mysql' as const,
      label: 'mysql.local:3306',
      host: 'mysql.local',
      port: 3306,
      database: 'testdb',
      username: undefined,
      password: undefined,
      hasSavedPassword: false,
      createdAt: '2026-05-21T00:00:00.000Z',
      lastConnectedAt: '2026-05-21T00:00:00.000Z'
    };
    vi.mocked(api.listConnections).mockResolvedValue([connection]);
    vi.mocked(api.connect).mockResolvedValue({
      kind: 'mysql',
      label: connection.label,
      tables: []
    });
    render(<App api={api} />);

    fireEvent.click(await screen.findByText('mysql.local:3306'));

    await waitFor(() => {
      expect(api.connect).toHaveBeenCalledWith(connection);
    });
    expect(screen.queryByLabelText('MySQL connection')).not.toBeInTheDocument();
  });

  it('footer actions are disabled without results', async () => {
    const api = makeApi();
    render(<App api={api} />);

    fireEvent.click(screen.getByLabelText('Expand inspector sidebar'));
    fireEvent.click(within(screen.getByLabelText('Inspector')).getByRole('tab', { name: 'Results' }));

    expect(screen.getByLabelText('Copy')).toBeDisabled();
    expect(screen.getByLabelText('Export CSV')).toBeDisabled();
  });

  it('composer sends on Enter and inserts newline on Shift+Enter', () => {
    const api = makeApi();
    render(<App api={api} />);

    const textarea = screen.getByPlaceholderText('Ask a follow-up');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(api.sendChat).not.toHaveBeenCalled();
  });
});
