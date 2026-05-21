import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  KeyRound,
  LayoutDashboard,
  Loader2,
  MessageSquareText,
  Moon,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  TerminalSquare,
  Trash2
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  ConnectionConfig,
  ConnectionHistoryItem,
  DatabaseSchema,
  ModelChatMessage,
  ModelInfo,
  ModelProviderKind,
  PersistedChatSession,
  PersistedSettings,
  QueryResult,
  QueryValidationResult
} from '../shared/types';

const fallbackApi = typeof window !== 'undefined' ? window.dbchat : undefined;
const themeStorageKey = 'dbchat:theme';

type InspectorTab = 'results' | 'query' | 'schema';
type ThemeMode = 'light' | 'dark';

const starterPrompts = [
  {
    title: 'Summarize this database',
    prompt: 'Summarize the connected database and suggest the most useful questions to ask next.'
  },
  {
    title: 'Show top records',
    prompt: 'Show me the most important records in the main table and explain what stands out.'
  },
  {
    title: 'Explain the schema',
    prompt: 'Explain the available tables and columns in this database.'
  },
  {
    title: 'Check data quality',
    prompt: 'Look for missing values, duplicates, or unusual patterns in this database.'
  }
];

const initialAssistantMessage = 'Connect SQLite or Elasticsearch to start asking questions about your data.';

function nowMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

function loadInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }
  return window.localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
}

function createInitialMessages(): ChatMessage[] {
  return [nowMessage('assistant', initialAssistantMessage)];
}

function buildChatTitle(messages: ChatMessage[], connection: ConnectionConfig | null): string {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
  const title = firstUserMessage || connection?.label || 'New chat';
  return title.length > 56 ? `${title.slice(0, 53)}...` : title;
}

function formatHistoryDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function errorStatus(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback;
  }

  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function elasticsearchHistoryValues(config: ConnectionConfig) {
  if (config.elasticsearchHost) {
    return {
      host: config.elasticsearchHost,
      port: String(config.elasticsearchPort ?? 9200),
      useSsl: config.elasticsearchUseSsl ?? false,
      verifyCerts: config.elasticsearchVerifyCerts ?? true
    };
  }

  try {
    const url = new URL(config.elasticsearchUrl ?? '');
    return {
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      useSsl: url.protocol === 'https:',
      verifyCerts: config.elasticsearchVerifyCerts ?? true
    };
  } catch {
    return {
      host: '',
      port: '9200',
      useSsl: false,
      verifyCerts: true
    };
  }
}

export function App({ api = fallbackApi }: { api?: typeof window.dbchat }) {
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(createInitialMessages);
  const [prompt, setPrompt] = useState('');
  const [query, setQuery] = useState('');
  const [validation, setValidation] = useState<QueryValidationResult | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [chatSessions, setChatSessions] = useState<PersistedChatSession[]>([]);
  const [savedConnections, setSavedConnections] = useState<ConnectionHistoryItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [settings, setSettings] = useState<PersistedSettings & { hasApiKey: boolean }>({
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    safeMode: true,
    hasApiKey: false
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState(settings.model);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [answerGenerating, setAnswerGenerating] = useState(false);
  const [activeInspector, setActiveInspector] = useState<InspectorTab>('schema');
  const [theme, setTheme] = useState<ThemeMode>(loadInitialTheme);
  const [elasticsearchFormOpen, setElasticsearchFormOpen] = useState(false);
  const [elasticsearchHost, setElasticsearchHost] = useState('localhost');
  const [elasticsearchPort, setElasticsearchPort] = useState('9200');
  const [elasticsearchUseSsl, setElasticsearchUseSsl] = useState(false);
  const [elasticsearchVerifyCerts, setElasticsearchVerifyCerts] = useState(true);
  const [elasticsearchUsername, setElasticsearchUsername] = useState('');
  const [elasticsearchPassword, setElasticsearchPassword] = useState('');
  const [elasticsearchRememberPassword, setElasticsearchRememberPassword] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!api) {
      setStatus('Desktop app bridge unavailable. Run DB Chat in Electron to connect databases.');
      return;
    }
    void api.loadSettings().then(setSettings).catch(() => setStatus('Settings are using defaults.'));
    void refreshHistories(api);
  }, [api]);

  useEffect(() => {
    if (!api) {
      setModels([]);
      return;
    }

    let active = true;
    setModelsLoading(true);
    setSettingsStatus('Loading models...');
    void api.listModels(settings.provider)
      .then((nextModels) => {
        if (!active) return;
        setModels(nextModels);
        setSettingsStatus(nextModels.length ? 'Models loaded.' : 'No models returned for this provider.');
        if (nextModels.length && !nextModels.some((model) => model.id === settings.model)) {
          const nextSettings = { ...settings, model: nextModels[0].id };
          setSettings((current) => ({ ...current, model: nextModels[0].id }));
          setModelSearch(nextModels[0].id);
          void api.saveSettings(nextSettings);
        }
      })
      .catch((error: Error) => {
        if (!active) return;
        setModels([]);
        setSettingsStatus(error.message || 'Could not load models.');
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [api, settings.provider]);

  useEffect(() => {
    setModelSearch(settings.model);
  }, [settings.model]);

  useEffect(() => {
    if (!api || !query) {
      setValidation(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void api.validateQuery(query, 'safe').then(setValidation).catch((error: Error) => {
        setValidation({ safe: false, reason: error.message, normalizedQuery: query });
      });
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [api, query]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, answerGenerating]);

  const schemaSummary = useMemo(() => {
    if (!schema) {
      return 'No database connected';
    }
    const unit = schema.kind === 'elasticsearch'
      ? (schema.tables.length === 1 ? 'index' : 'indices')
      : (schema.tables.length === 1 ? 'table' : 'tables');
    return `${schema.tables.length} ${unit} connected`;
  }, [schema]);

  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) {
      return models;
    }
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(query));
  }, [modelSearch, models]);

  const hasOnlyWelcomeMessage = messages.length === 1 && messages[0]?.role === 'assistant';

  async function refreshHistories(nextApi = api) {
    if (!nextApi) return;
    const [nextSessions, nextConnections] = await Promise.all([
      nextApi.listChatSessions(),
      nextApi.listConnections()
    ]);
    setChatSessions(nextSessions);
    setSavedConnections(nextConnections);
  }

  async function persistChatSession(
    nextMessages: ChatMessage[],
    overrides: Partial<Pick<PersistedChatSession, 'query' | 'result' | 'connection'>> = {}
  ) {
    if (!api || !nextMessages.some((message) => message.role === 'user')) {
      return null;
    }
    const existing = activeChatId ? chatSessions.find((session) => session.id === activeChatId) : undefined;
    const timestamp = new Date().toISOString();
    const session: PersistedChatSession = {
      id: existing?.id ?? crypto.randomUUID(),
      title: buildChatTitle(nextMessages, overrides.connection ?? connection),
      messages: nextMessages,
      connection: overrides.connection ?? connection ?? undefined,
      query: (overrides.query ?? query) || undefined,
      result: overrides.result ?? result ?? undefined,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    const saved = await api.saveChatSession(session);
    setActiveChatId(saved.id);
    await refreshHistories();
    return saved;
  }

  function resetChat() {
    setActiveChatId(null);
    setMessages(createInitialMessages());
    setPrompt('');
    setQuery('');
    setValidation(null);
    setResult(null);
    setActiveInspector('schema');
    setStatus('Ready for a new chat');
  }

  async function connectSqlite() {
    if (!api) {
      setStatus('SQLite connections are available in the Electron desktop app.');
      return;
    }
    setBusy(true);
    setStatus('Opening SQLite file picker...');
    try {
      const config = await api.chooseSqliteFile();
      if (!config) {
        setStatus('Connection canceled.');
        return;
      }
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} tables.`)
      ]);
      setStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      setStatus(errorStatus(error, 'Could not connect to database.'));
    } finally {
      setBusy(false);
    }
  }

  async function connectElasticsearch(event?: FormEvent) {
    event?.preventDefault();
    if (!api) {
      setStatus('Elasticsearch connections are available in the Electron desktop app.');
      return;
    }
    if (!elasticsearchHost.trim()) {
      setStatus('Enter an Elasticsearch host before connecting.');
      return;
    }
    const port = Number(elasticsearchPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      setStatus('Enter an Elasticsearch port between 1 and 65535.');
      return;
    }

    setBusy(true);
    setStatus('Connecting to Elasticsearch...');
    try {
      const config: ConnectionConfig = {
        id: crypto.randomUUID(),
        kind: 'elasticsearch',
        label: `${elasticsearchHost.trim()}:${port}`,
        elasticsearchHost: elasticsearchHost.trim(),
        elasticsearchPort: port,
        elasticsearchUseSsl,
        elasticsearchVerifyCerts,
        elasticsearchUsername: elasticsearchUsername.trim() || undefined,
        elasticsearchPassword: elasticsearchPassword || undefined,
        elasticsearchRememberPassword,
        createdAt: new Date().toISOString()
      };
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setElasticsearchFormOpen(false);
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} indices.`)
      ]);
      setStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      setStatus(errorStatus(error, 'Could not connect to Elasticsearch.'));
    } finally {
      setBusy(false);
    }
  }

  async function connectFromHistory(config: ConnectionConfig) {
    if (!api) return;
    if (config.kind === 'elasticsearch' && !config.elasticsearchPassword && !config.elasticsearchHasSavedPassword) {
      prepareElasticsearchReconnect(config, `Enter the password to reconnect ${config.label}.`);
      return;
    }
    setBusy(true);
    setStatus(`Connecting to ${config.label}...`);
    try {
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      setStatus(errorStatus(error, 'Could not connect to saved database.'));
    } finally {
      setBusy(false);
    }
  }

  async function openChatSession(session: PersistedChatSession) {
    if (!api) return;
    setActiveChatId(session.id);
    setMessages(session.messages.length ? session.messages : createInitialMessages());
    setPrompt('');
    setQuery(session.query ?? '');
    setResult(session.result ?? null);
    setActiveInspector(session.result ? 'results' : session.query ? 'query' : 'schema');
    setStatus(`Opened ${session.title}`);

    if (session.connection) {
      if (session.connection.kind === 'elasticsearch'
        && !session.connection.elasticsearchPassword
        && !session.connection.elasticsearchHasSavedPassword) {
        prepareElasticsearchReconnect(session.connection, `Opened ${session.title}. Enter the password to reconnect ${session.connection.label}.`);
        return;
      }
      setBusy(true);
      try {
        const nextSchema = await api.connect(session.connection);
        setConnection(session.connection);
        setSchema(nextSchema);
        await refreshHistories();
      } catch (error) {
        setStatus(errorStatus(error, `Opened ${session.title}, but could not reconnect the database.`));
      } finally {
        setBusy(false);
      }
    }
  }

  async function deleteChatSession(id: string) {
    if (!api) return;
    await api.deleteChatSession(id);
    if (activeChatId === id) {
      resetChat();
    }
    await refreshHistories();
    setStatus('Chat deleted');
  }

  async function deleteConnection(id: string) {
    if (!api) return;
    await api.deleteConnection(id);
    await refreshHistories();
    setStatus('Saved connection deleted');
  }

  function prepareElasticsearchReconnect(config: ConnectionConfig, nextStatus: string) {
    const values = elasticsearchHistoryValues(config);
    setElasticsearchHost(values.host);
    setElasticsearchPort(values.port);
    setElasticsearchUseSsl(values.useSsl);
    setElasticsearchVerifyCerts(values.verifyCerts);
    setElasticsearchUsername(config.elasticsearchUsername ?? '');
    setElasticsearchPassword('');
    setElasticsearchRememberPassword(Boolean(config.elasticsearchHasSavedPassword || config.elasticsearchRememberPassword));
    setElasticsearchFormOpen(true);
    setStatus(nextStatus);
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault();
    if (!api || !prompt.trim()) return;

    const userMessage = nowMessage('user', prompt.trim());
    const nextMessages = [...messages, userMessage];
    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setBusy(true);
    setAnswerGenerating(true);
    setStatus('Thinking...');
    try {
      const chatHistory: ModelChatMessage[] = nextMessages.map((message) => ({
        role: message.role,
        content: message.content
      }));
      const response = await api.sendChat(chatHistory);
      const finalMessages = [...nextMessages, response.message];
      setMessages(finalMessages);
      if (response.generatedQuery) {
        setQuery(response.generatedQuery.query);
        setValidation(response.generatedQuery.validation);
        setActiveInspector('query');
      }
      if (response.queryResult) {
        setResult(response.queryResult);
        setActiveInspector('results');
        setStatus(`Returned ${response.queryResult.rowCount} rows in ${response.queryResult.elapsedMs} ms`);
      } else {
        setStatus('Response ready');
      }
      await persistChatSession(finalMessages, {
        query: response.generatedQuery?.query ?? query,
        result: response.queryResult ?? result ?? undefined
      });
    } catch (error) {
      setStatus(errorStatus(error, 'Chat failed.'));
    } finally {
      setAnswerGenerating(false);
      setBusy(false);
    }
  }

  async function runQuery() {
    if (!api || !query.trim()) return;
    setBusy(true);
    setStatus('Running safe query...');
    try {
      const nextResult = await api.executeQuery(query);
      setResult(nextResult);
      setActiveInspector('results');
      setStatus(`Returned ${nextResult.rowCount} rows in ${nextResult.elapsedMs} ms`);
      await persistChatSession(messages, { query, result: nextResult });
    } catch (error) {
      setStatus(errorStatus(error, 'Query failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(next: PersistedSettings) {
    if (!api) return;
    setSettings((current) => ({ ...current, ...next }));
    await api.saveSettings(next);
  }

  async function changeProvider(provider: ModelProviderKind) {
    const fallbackModel = provider === 'openrouter' ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini';
    const nextSettings = { ...settings, provider, model: fallbackModel };
    setSettings((current) => ({ ...current, provider, model: fallbackModel, hasApiKey: false }));
    setModelSearch(fallbackModel);
    setSettingsStatus('Loading models...');
    await api?.saveSettings(nextSettings);
    const loadedSettings = await api?.loadSettings();
    if (loadedSettings) {
      setSettings((current) => ({ ...current, hasApiKey: loadedSettings.hasApiKey }));
    }
  }

  async function changeModel(model: string) {
    const nextSettings = { ...settings, model };
    await saveSettings(nextSettings);
    setSettingsStatus('Model saved.');
  }

  async function changeModelSearch(value: string) {
    setModelSearch(value);
    const match = models.find((model) => model.id === value || model.name === value);
    if (match && match.id !== settings.model) {
      await changeModel(match.id);
      setModelSearch(match.id);
    }
  }

  async function saveApiKey() {
    if (!api || !apiKey.trim()) return;
    try {
      await api.saveApiKey(settings.provider, apiKey.trim());
      setSettings((current) => ({ ...current, hasApiKey: true }));
      setApiKey('');
      setSettingsStatus('API key saved successfully.');
      setStatus(`${settings.provider} API key saved locally.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save API key.';
      setSettingsStatus(message);
      setStatus(message);
    }
  }

  function chooseStarter(starterPrompt: string) {
    setPrompt(starterPrompt);
  }

  function renderInspector() {
    if (activeInspector === 'results') {
      return (
        <section className="inspector-body" aria-label="Data results">
          {result ? (
            <>
              <div className="result-summary">
                <strong>{result.rowCount}</strong>
                <span>{result.rowCount === 1 ? 'row' : 'rows'} returned in {result.elapsedMs} ms</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {result.columns.map((column) => <th key={column}>{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index}>
                        {result.columns.map((column) => <td key={column}>{String(row[column] ?? '')}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Table2 size={22} />
              <span>Ask a data question to see rows here.</span>
            </div>
          )}
        </section>
      );
    }

    if (activeInspector === 'query') {
      return (
        <section className="inspector-body query-inspector" aria-label="Query editor">
          <textarea
            className="query-editor"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={connection?.kind === 'elasticsearch' ? 'Generated Elasticsearch JSON will appear here.' : 'Generated SQL will appear here.'}
            spellCheck={false}
          />
          <div className={`validation ${validation?.safe ? 'safe' : 'blocked'}`}>
            {validation ? validation.reason : 'SAFE mode validation will appear here.'}
          </div>
          <div className="query-actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(query)} disabled={!query.trim()}>
              <Copy size={16} />
              Copy
            </button>
            <button type="button" className="primary-button" onClick={() => void runQuery()} disabled={busy || !validation?.safe}>
              <Play size={16} />
              Run Safe Query
            </button>
          </div>
        </section>
      );
    }

    return (
      <section className="inspector-body schema-panel" aria-label="Schema">
        {schema ? (
          <>
            <div className="schema-summary">
              <Database size={18} />
              <div>
                <strong>{connection?.label ?? 'Database'}</strong>
                <span>{schemaSummary}</span>
              </div>
            </div>
            <div className="schema-list">
              {schema.tables.map((table) => (
                <article className="schema-card" key={table.name}>
                  <div>
                    <strong>{table.name}</strong>
                    <span>{table.columns.length} columns</span>
                  </div>
                  <p>{table.columns.map((column) => column.name).join(', ') || 'No columns found'}</p>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <Database size={22} />
            <span>Connect SQLite or Elasticsearch to inspect its schema.</span>
          </div>
        )}
      </section>
    );
  }

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="sidebar" aria-label="Database workspace">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">DB</div>
          <div>
            <h1>DB Chat</h1>
            <p>Chat with database data</p>
          </div>
        </div>

        <label className="search-field">
          <Search size={16} />
          <input type="search" placeholder="Search tables" aria-label="Search tables" disabled={!schema} />
        </label>

        <section className="connection-card" aria-label="Connection status">
          <div>
            <span className={connection ? 'status-dot connected' : 'status-dot'} />
            <p>{connection ? 'Connected' : 'Not connected'}</p>
          </div>
          <strong>{connection ? connection.label : 'Choose a database'}</strong>
          <span>{schemaSummary}</span>
          <div className="connection-actions">
            <button type="button" className="secondary-button" onClick={connectSqlite} disabled={busy || !api}>
              <Database size={16} />
              SQLite
            </button>
            <button type="button" className="secondary-button" onClick={() => setElasticsearchFormOpen((current) => !current)} disabled={busy || !api}>
              <Search size={16} />
              Elasticsearch
            </button>
          </div>
          {elasticsearchFormOpen && (
            <form className="elasticsearch-form" aria-label="Elasticsearch connection" onSubmit={(event) => void connectElasticsearch(event)}>
              <label>
                <span>Host</span>
                <input
                  value={elasticsearchHost}
                  onChange={(event) => setElasticsearchHost(event.target.value)}
                  placeholder="localhost"
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  value={elasticsearchPort}
                  onChange={(event) => setElasticsearchPort(event.target.value)}
                  inputMode="numeric"
                  type="number"
                  min={1}
                  max={65535}
                />
              </label>
              <label>
                <span>Username</span>
                <input value={elasticsearchUsername} onChange={(event) => setElasticsearchUsername(event.target.value)} />
              </label>
              <label>
                <span>Password</span>
                <input type="password" value={elasticsearchPassword} onChange={(event) => setElasticsearchPassword(event.target.value)} />
              </label>
              <label className="elasticsearch-checkbox">
                <input type="checkbox" checked={elasticsearchUseSsl} onChange={(event) => setElasticsearchUseSsl(event.target.checked)} />
                <span>Use HTTPS</span>
              </label>
              <label className="elasticsearch-checkbox">
                <input
                  type="checkbox"
                  checked={elasticsearchVerifyCerts}
                  onChange={(event) => setElasticsearchVerifyCerts(event.target.checked)}
                  disabled={!elasticsearchUseSsl}
                />
                <span>Verify TLS certificates</span>
              </label>
              <label className="elasticsearch-checkbox">
                <input
                  type="checkbox"
                  checked={elasticsearchRememberPassword}
                  onChange={(event) => setElasticsearchRememberPassword(event.target.checked)}
                />
                <span>Remember password</span>
              </label>
              <button type="submit" className="primary-button" disabled={busy || !elasticsearchHost.trim() || !elasticsearchPort.trim()}>
                Connect
              </button>
            </form>
          )}
        </section>

        <nav className="sidebar-nav" aria-label="Workspace views">
          <button type="button" className="active">
            <MessageSquareText size={17} />
            Chat
          </button>
          <button type="button" className={activeInspector === 'results' ? 'active' : ''} onClick={() => setActiveInspector('results')}>
            <Table2 size={17} />
            Results
          </button>
          <button type="button" className={activeInspector === 'query' ? 'active' : ''} onClick={() => setActiveInspector('query')}>
            <TerminalSquare size={17} />
            Query
          </button>
          <button type="button" className={activeInspector === 'schema' ? 'active' : ''} onClick={() => setActiveInspector('schema')}>
            <LayoutDashboard size={17} />
            Schema
          </button>
        </nav>

        <section className="history-section" aria-label="Chat history">
          <div className="history-heading">
            <span>Chat history</span>
            <button type="button" onClick={resetChat} aria-label="New chat">
              <Plus size={14} />
            </button>
          </div>
          <div className="history-list">
            {chatSessions.length ? chatSessions.map((session) => (
              <article className={`history-item ${activeChatId === session.id ? 'active' : ''}`} key={session.id}>
                <button type="button" className="history-main" onClick={() => void openChatSession(session)}>
                  <MessageSquareText size={15} />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{formatHistoryDate(session.updatedAt)}</small>
                  </span>
                </button>
                <button type="button" className="history-delete" onClick={() => void deleteChatSession(session.id)} aria-label={`Delete chat ${session.title}`}>
                  <Trash2 size={14} />
                </button>
              </article>
            )) : (
              <p className="history-empty">Saved chats will appear here.</p>
            )}
          </div>
        </section>

        <section className="history-section" aria-label="Connection history">
          <div className="history-heading">
            <span>Connect history</span>
            <Clock3 size={14} aria-hidden="true" />
          </div>
          <div className="history-list">
            {savedConnections.length ? savedConnections.map((item) => (
              <article className="history-item" key={item.id}>
                <button type="button" className="history-main" onClick={() => void connectFromHistory(item)} disabled={busy}>
                  <Database size={15} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{formatHistoryDate(item.lastConnectedAt)}</small>
                  </span>
                </button>
                <button type="button" className="history-delete" onClick={() => void deleteConnection(item.id)} aria-label={`Delete connection ${item.label}`}>
                  <Trash2 size={14} />
                </button>
              </article>
            )) : (
              <p className="history-empty">Connected databases will appear here.</p>
            )}
          </div>
        </section>

        <div className="sidebar-spacer" />

        <label className="safe-toggle">
          <input
            type="checkbox"
            checked={settings.safeMode}
            onChange={(event) => void saveSettings({ ...settings, safeMode: event.target.checked })}
            aria-label="SAFE mode"
          />
          <ShieldCheck size={16} />
          SAFE mode
        </label>

        <div className="theme-toggle" aria-label="Theme">
          <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
            <Sun size={16} />
            Light
          </button>
          <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
            <Moon size={16} />
            Dark
          </button>
        </div>

        <button
          type="button"
          className="settings-button"
          onClick={() => setSettingsOpen((current) => !current)}
          aria-expanded={settingsOpen}
          aria-label="Open settings"
        >
          <Settings size={17} />
          Settings
          {settings.hasApiKey && <CheckCircle2 className="settings-saved-dot" size={14} aria-label="API key saved" />}
        </button>

        {settingsOpen && (
          <section className="settings-panel" aria-label="Settings">
            <div className="settings-grid">
              <label>
                <span>Provider</span>
                <select
                  value={settings.provider}
                  onChange={(event) => void changeProvider(event.target.value as ModelProviderKind)}
                  aria-label="Model provider"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI</option>
                </select>
              </label>

              <label>
                <span>Model</span>
                <div className="model-select-wrap">
                  <input
                    value={modelSearch}
                    onChange={(event) => void changeModelSearch(event.target.value)}
                    list="model-options"
                    disabled={modelsLoading || !models.length}
                    aria-label="Model name"
                    placeholder={modelsLoading ? 'Loading models...' : 'Search models'}
                  />
                  <datalist id="model-options">
                    {filteredModels.map((model) => (
                      <option value={model.id} key={model.id}>{model.name}</option>
                    ))}
                  </datalist>
                  {modelsLoading && <Loader2 className="spin" size={16} aria-label="Loading models" />}
                </div>
              </label>

              <label className="api-key-field">
                <span>{settings.provider} API key</span>
                <div className="api-key-box">
                  <KeyRound size={15} />
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={settings.hasApiKey ? 'API key saved' : 'Paste API key'}
                    aria-label="API key"
                  />
                  <button type="button" onClick={() => void saveApiKey()} disabled={!apiKey.trim()}>
                    Save
                  </button>
                </div>
              </label>
            </div>
            <div className={`settings-status ${settings.hasApiKey ? 'saved' : ''}`}>
              {settings.hasApiKey && <CheckCircle2 size={15} />}
              {settingsStatus || (settings.hasApiKey ? 'API key saved.' : 'Settings are stored locally.')}
            </div>
          </section>
        )}

        <div className="provider-card">
          <span>{settings.provider}</span>
          <strong>{settings.model}</strong>
          <p>{settings.hasApiKey ? 'API key saved locally' : 'API key not saved'}</p>
        </div>
      </aside>

      <section className="chat-pane" aria-label="Chat">
        <header className="chat-header">
          <div>
            <p>AI data workspace</p>
            <h2>Ask your database anything</h2>
          </div>
          <div className="chat-status" title={status}>
            <Sparkles size={16} />
            <span>{status}</span>
          </div>
        </header>

        <div className="messages">
          {hasOnlyWelcomeMessage && (
            <section className="welcome-panel" aria-label="Starter prompts">
              <div>
                <h3>Welcome to DB Chat</h3>
                <p>Connect SQLite or Elasticsearch, ask a question, and DB Chat will run safe read-only analysis for you.</p>
              </div>
              <div className="starter-grid">
                {starterPrompts.map((starter) => (
                  <button type="button" className="starter-card" onClick={() => chooseStarter(starter.prompt)} key={starter.title}>
                    <span>{starter.title}</span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </section>
          )}
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </article>
          ))}
          {answerGenerating && (
            <article className="message assistant generating" aria-live="polite" aria-label="Generating answer">
              <Loader2 className="message-spinner" size={16} aria-hidden="true" />
              <span>Generating answer</span>
            </article>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={(event) => void sendChat(event)}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask about the connected database..."
            rows={3}
          />
          <div className="composer-footer">
            <span>{prompt.length} / 3,000</span>
            <button type="submit" disabled={busy || !prompt.trim()} aria-label="Send message">
              <Send size={18} />
            </button>
          </div>
        </form>
      </section>

      <aside className="inspector" aria-label="Inspector">
        <header className="inspector-header">
          <div>
            <p>Inspector</p>
            <h2>{activeInspector === 'results' ? 'Results' : activeInspector === 'query' ? 'Query' : 'Schema'}</h2>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
            <button type="button" className={activeInspector === 'results' ? 'active' : ''} onClick={() => setActiveInspector('results')}>
              Results
            </button>
            <button type="button" className={activeInspector === 'query' ? 'active' : ''} onClick={() => setActiveInspector('query')}>
              Query
            </button>
            <button type="button" className={activeInspector === 'schema' ? 'active' : ''} onClick={() => setActiveInspector('schema')}>
              Schema
            </button>
          </div>
        </header>
        {renderInspector()}
      </aside>
    </main>
  );
}
