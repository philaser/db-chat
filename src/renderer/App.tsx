import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  KeyRound,
  List,
  Loader2,
  MessageSquareText,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  Trash2
} from 'lucide-react';
import {
  FormEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
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
type AppView = 'workspace' | 'connections' | 'history' | 'settings';
type ThemeMode = 'light' | 'dark';
type ResizeSide = 'right';
type LogLevel = 'info' | 'error';
type AppLogEntry = {
  id: string;
  level: LogLevel;
  message: string;
  detail?: string;
  timestamp: string;
};
type ResizeDrag = {
  pointerId: number;
  shellWidth: number;
  side: ResizeSide;
  startWidth: number;
  startX: number;
  staticPanelWidth: number;
};

const leftPanelWidth = 74;
const rightPanelDefaultWidth = 380;
const rightPanelMinWidth = 300;
const rightPanelMaxWidth = 520;
const panelRailWidth = 54;
const chatPaneMinWidth = 540;
const keyboardResizeStep = 24;

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

function logDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) {
    return undefined;
  }

  return error.message;
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

function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, width));
}

function getPanelMaxWidth(shellWidth: number, staticPanelWidth: number, minWidth: number, maxWidth: number): number {
  if (!shellWidth) {
    return maxWidth;
  }

  return Math.max(minWidth, Math.min(maxWidth, shellWidth - staticPanelWidth - chatPaneMinWidth));
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
  const [activeView, setActiveView] = useState<AppView>('workspace');
  const [recentChatsOpen, setRecentChatsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<AppLogEntry[]>([]);
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
  const [rightPanelWidth, setRightPanelWidth] = useState(rightPanelDefaultWidth);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  function appendLog(level: LogLevel, message: string, detail?: string) {
    setLogs((current) => [{
      id: crypto.randomUUID(),
      level,
      message,
      detail,
      timestamp: new Date().toISOString()
    }, ...current].slice(0, 150));
  }

  function updateStatus(message: string) {
    setStatus(message);
    appendLog('info', message);
  }

  function reportError(message: string, error: unknown) {
    setStatus(message);
    appendLog('error', message, logDetail(error));
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    if (!api) {
      updateStatus('Desktop app bridge unavailable. Run DB Chat in Electron to connect databases.');
      return;
    }
    void api.loadSettings().then(setSettings).catch((error) => reportError('Settings could not be loaded. Defaults are in use.', error));
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
        setSettingsStatus('Models could not be loaded.');
        appendLog('error', 'Models could not be loaded.', logDetail(error));
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
      void api.validateQuery(query, settings.safeMode ? 'safe' : 'manual').then(setValidation).catch((error: Error) => {
        setValidation({ safe: false, reason: error.message, normalizedQuery: query });
      });
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [api, query, settings.safeMode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, answerGenerating]);

  useEffect(() => {
    if (!resizeDrag) {
      return;
    }

    const drag = resizeDrag;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function moveResize(event: PointerEvent) {
      if (event.pointerId !== drag.pointerId) {
        return;
      }

      const direction = -1;
      const delta = (event.clientX - drag.startX) * direction;
      const maxWidth = getPanelMaxWidth(
        drag.shellWidth,
        drag.staticPanelWidth,
        rightPanelMinWidth,
        rightPanelMaxWidth
      );
      const nextWidth = clampPanelWidth(
        drag.startWidth + delta,
        rightPanelMinWidth,
        maxWidth
      );

      setRightPanelWidth(nextWidth);
    }

    function finishResize(event: PointerEvent) {
      if (event.pointerId === drag.pointerId) {
        setResizeDrag(null);
      }
    }

    window.addEventListener('pointermove', moveResize);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', moveResize);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };
  }, [resizeDrag]);

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
  const activeChatTitle = buildChatTitle(messages, connection);

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
    setActiveView('workspace');
    setRecentChatsOpen(false);
    updateStatus('Ready for a new chat');
  }

  function openView(view: AppView) {
    setActiveView(view);
    setRecentChatsOpen(false);
  }

  async function connectSqlite() {
    if (!api) {
      updateStatus('SQLite connections are available in the Electron desktop app.');
      return;
    }
    setBusy(true);
    updateStatus('Opening SQLite file picker...');
    try {
      const config = await api.chooseSqliteFile();
      if (!config) {
        updateStatus('Connection canceled.');
        return;
      }
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setActiveView('workspace');
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} tables.`)
      ]);
      updateStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      reportError('Could not connect to the database.', error);
    } finally {
      setBusy(false);
    }
  }

  async function connectElasticsearch(event?: FormEvent) {
    event?.preventDefault();
    if (!api) {
      updateStatus('Elasticsearch connections are available in the Electron desktop app.');
      return;
    }
    if (!elasticsearchHost.trim()) {
      updateStatus('Enter an Elasticsearch host before connecting.');
      return;
    }
    const port = Number(elasticsearchPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      updateStatus('Enter an Elasticsearch port between 1 and 65535.');
      return;
    }

    setBusy(true);
    updateStatus('Connecting to Elasticsearch...');
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
      setActiveView('workspace');
      setElasticsearchFormOpen(false);
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} indices.`)
      ]);
      updateStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      reportError('Could not connect to Elasticsearch.', error);
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
    updateStatus(`Connecting to ${config.label}...`);
    try {
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setActiveView('workspace');
      updateStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      reportError('Could not connect to the saved database.', error);
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
    setActiveView('workspace');
    setRecentChatsOpen(false);
    updateStatus(`Opened ${session.title}`);

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
        reportError(`Opened ${session.title}, but could not reconnect the database.`, error);
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
    updateStatus('Chat deleted');
  }

  async function deleteConnection(id: string) {
    if (!api) return;
    await api.deleteConnection(id);
    await refreshHistories();
    updateStatus('Saved connection deleted');
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
    updateStatus(nextStatus);
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
    updateStatus('Thinking...');
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
        updateStatus(`Returned ${response.queryResult.rowCount} rows in ${response.queryResult.elapsedMs} ms`);
      } else {
        updateStatus('Response ready');
      }
      await persistChatSession(finalMessages, {
        query: response.generatedQuery?.query ?? query,
        result: response.queryResult ?? result ?? undefined
      });
    } catch (error) {
      reportError('The chat request failed.', error);
    } finally {
      setAnswerGenerating(false);
      setBusy(false);
    }
  }

  async function runQuery() {
    if (!api || !query.trim()) return;
    setBusy(true);
    updateStatus(settings.safeMode ? 'Running safe query...' : 'Running validated query...');
    try {
      const nextResult = await api.executeQuery(query, settings.safeMode ? 'safe' : 'manual');
      setResult(nextResult);
      setActiveInspector('results');
      updateStatus(`Returned ${nextResult.rowCount} rows in ${nextResult.elapsedMs} ms`);
      await persistChatSession(messages, { query, result: nextResult });
    } catch (error) {
      reportError('The query could not be run.', error);
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
      updateStatus(`${settings.provider} API key saved locally.`);
    } catch (error) {
      setSettingsStatus('API key could not be saved.');
      reportError('API key could not be saved.', error);
    }
  }

  function chooseStarter(starterPrompt: string) {
    setPrompt(starterPrompt);
  }

  function getShellWidth(): number {
    return shellRef.current?.getBoundingClientRect().width ?? 0;
  }

  function beginPanelResize(side: ResizeSide, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    setResizeDrag({
      pointerId: event.pointerId,
      shellWidth: getShellWidth(),
      side,
      startWidth: rightPanelWidth,
      startX: event.clientX,
      staticPanelWidth: leftPanelWidth
    });
  }

  function resizePanelWithKeyboard(side: ResizeSide, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }

    event.preventDefault();
    const handleDelta = event.key === 'ArrowRight' ? keyboardResizeStep : -keyboardResizeStep;
    const widthDelta = -handleDelta;
    const shellWidth = getShellWidth();

    const maxWidth = getPanelMaxWidth(
      shellWidth,
      leftPanelWidth,
      rightPanelMinWidth,
      rightPanelMaxWidth
    );
    setRightPanelWidth((current) => clampPanelWidth(current + widthDelta, rightPanelMinWidth, maxWidth));
  }

  function renderInspector() {
    if (activeInspector === 'results') {
      return (
        <section className="inspector-body" aria-label="Data results">
          {result ? (
            <>
              <div className="result-summary">
                <div className="result-metric">
                  <strong>{result.rowCount}</strong>
                  <span>{result.rowCount === 1 ? 'row' : 'rows'}</span>
                </div>
                <div className="result-metric">
                  <strong>{result.columns.length}</strong>
                  <span>{result.columns.length === 1 ? 'column' : 'columns'}</span>
                </div>
                <p>Returned in {result.elapsedMs} ms</p>
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
            <ShieldCheck size={16} />
            <span>{validation ? validation.reason : 'Query validation will appear here.'}</span>
          </div>
          <div className="query-actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(query)} disabled={!query.trim()}>
              <Copy size={16} />
              Copy
            </button>
            <button type="button" className="primary-button" onClick={() => void runQuery()} disabled={busy || !validation?.safe}>
              <Play size={16} />
              {settings.safeMode ? 'Run Safe Query' : 'Run Validated Query'}
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

  function renderElasticsearchForm() {
    if (!elasticsearchFormOpen) {
      return null;
    }

    return (
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
    );
  }

  function renderSettingsControls() {
    return (
      <>
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
      </>
    );
  }

  function renderChatHistory(limit?: number) {
    const sessions = typeof limit === 'number' ? chatSessions.slice(0, limit) : chatSessions;
    return (
      <div className="history-list">
        {sessions.length ? sessions.map((session) => (
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
    );
  }

  function renderFocusedView() {
    if (activeView === 'workspace') {
      return null;
    }

    if (activeView === 'connections') {
      return (
        <section className="focus-view" aria-label="Connections">
          <header className="focus-header">
            <div>
              <p>Database access</p>
              <h2>Connections</h2>
            </div>
            <button type="button" onClick={() => openView('workspace')}>Back to chat</button>
          </header>
          <div className="focus-grid connections-view">
            <section className="focus-panel" aria-label="Connection status">
              <div className="connection-kicker">
                <span className={connection ? 'status-dot connected' : 'status-dot'} />
                <p>{connection ? 'Active connection' : 'No active connection'}</p>
              </div>
              <div className="connection-copy">
                <strong>{connection ? connection.label : 'Choose a database'}</strong>
                <span>{schemaSummary}</span>
              </div>
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
              {renderElasticsearchForm()}
            </section>
            <section className="focus-panel history-section" aria-label="Connection history">
              <div className="history-heading">
                <span>Saved connections</span>
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
          </div>
          <div className="focus-status" title={status}>
            <Sparkles size={15} />
            <span>{status}</span>
          </div>
        </section>
      );
    }

    if (activeView === 'history') {
      return (
        <section className="focus-view" aria-label="Chat history">
          <header className="focus-header">
            <div>
              <p>Saved conversations</p>
              <h2>History</h2>
            </div>
            <button type="button" className="primary-button" onClick={resetChat}>
              <Plus size={16} />
              New chat
            </button>
          </header>
          <section className="focus-panel history-section">{renderChatHistory()}</section>
          <div className="focus-status" title={status}>
            <Sparkles size={15} />
            <span>{status}</span>
          </div>
        </section>
      );
    }

    return (
      <section className="focus-view" aria-label="Settings">
        <header className="focus-header">
          <div>
            <p>Model and safety</p>
            <h2>Settings</h2>
          </div>
          <button type="button" onClick={() => openView('workspace')}>Back to chat</button>
        </header>
        <div className="focus-grid settings-view">
          <section className="focus-panel settings-panel">{renderSettingsControls()}</section>
          <section className="focus-panel preferences-panel" aria-label="Workspace preferences">
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
            <div className="provider-card">
              <span>{settings.provider}</span>
              <strong>{settings.model}</strong>
              <p>{settings.hasApiKey ? 'API key saved locally' : 'API key not saved'}</p>
            </div>
            <button
              aria-expanded={logsOpen}
              className="logs-button"
              onClick={() => setLogsOpen((current) => !current)}
              type="button"
            >
              <List size={17} />
              {logsOpen ? 'Hide logs' : 'View logs'}
            </button>
          </section>
        </div>
        {logsOpen && (
          <section className="focus-panel logs-viewer" aria-label="Application logs">
            <div className="logs-heading">
              <div>
                <p>Recent activity</p>
                <h3>Logs</h3>
              </div>
              <button type="button" onClick={() => setLogs([])} disabled={!logs.length}>Clear</button>
            </div>
            <div className="logs-list">
              {logs.length ? logs.map((entry) => (
                <article className={`log-entry ${entry.level}`} key={entry.id}>
                  <div>
                    <strong>{entry.message}</strong>
                    <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  </div>
                  {entry.detail && <pre>{entry.detail}</pre>}
                </article>
              )) : (
                <p className="history-empty">App activity and error details will appear here.</p>
              )}
            </div>
          </section>
        )}
        <div className="focus-status" title={status}>
          <Sparkles size={15} />
          <span>{status}</span>
        </div>
      </section>
    );
  }

  const shellStyle = {
    '--left-panel-width': `${leftPanelWidth}px`,
    '--right-panel-width': `${rightPanelCollapsed ? panelRailWidth : rightPanelWidth}px`
  } as CSSProperties;

  return (
    <main
      className={`app-shell${resizeDrag ? ' resizing-panels' : ''}`}
      data-theme={theme}
      ref={shellRef}
      style={shellStyle}
    >
      <aside className="sidebar workspace-rail-open" id="workspace-sidebar" aria-label="Database workspace">
          <nav className="icon-rail" aria-label="Workspace destinations">
            <button
              aria-label="Chat workspace"
              className={`rail-action brand-action ${activeView === 'workspace' ? 'active' : ''}`}
              onClick={() => openView('workspace')}
              type="button"
            >
              <span className="brand-mark" aria-hidden="true">DB</span>
              <span className="rail-tooltip">Chat workspace</span>
            </button>
            <button aria-label="New chat" className="rail-action" onClick={resetChat} type="button">
              <Plus size={19} />
              <span className="rail-tooltip">New chat</span>
            </button>
            <div className="recent-anchor">
              <button
                aria-expanded={recentChatsOpen}
                aria-label="Recent chats"
                className={`rail-action ${activeView === 'history' || recentChatsOpen ? 'active' : ''}`}
                onClick={() => {
                  if (activeView !== 'workspace') {
                    openView('history');
                    return;
                  }
                  setRecentChatsOpen((current) => !current);
                }}
                type="button"
              >
                <Clock3 size={19} />
                <span className="rail-tooltip">Recent chats</span>
              </button>
              {activeView === 'workspace' && recentChatsOpen && (
                <section className="recent-flyout" aria-label="Recent chats flyout">
                  <div className="history-heading">
                    <span>Recent chats</span>
                    <button type="button" onClick={() => openView('history')}>All history</button>
                  </div>
                  {renderChatHistory(4)}
                </section>
              )}
            </div>
            <button
              aria-label="Connections"
              className={`rail-action ${activeView === 'connections' ? 'active' : ''}`}
              onClick={() => openView('connections')}
              type="button"
            >
              <Database size={19} />
              {connection && <span className="rail-status-dot" aria-hidden="true" />}
              <span className="rail-tooltip">Connections</span>
            </button>
            <button
              aria-label="Settings"
              className={`rail-action ${activeView === 'settings' ? 'active' : ''}`}
              onClick={() => openView('settings')}
              type="button"
            >
              <Settings size={19} />
              {settings.hasApiKey && <CheckCircle2 className="rail-saved" size={12} aria-label="API key saved" />}
              <span className="rail-tooltip">Settings</span>
            </button>
          </nav>
        </aside>

      <section className="chat-pane" aria-label={activeView === 'workspace' ? 'Chat' : 'Workspace view'}>
        {renderFocusedView() ?? (
          <>
        <header className="chat-header">
          <div className="chat-heading">
            <div className="chat-title-row">
              <h2>{activeChatTitle}</h2>
              <div className="workspace-context">
                <button
                  aria-label="Open connections"
                  className="context-chip connection-chip"
                  onClick={() => openView('connections')}
                  title={connection ? `Connected database: ${connection.label}` : 'Open connections'}
                  type="button"
                >
                  <Database size={14} />
                  <span className="context-label">{connection ? connection.label : 'No database connected'}</span>
                </button>
                <span
                  aria-label={settings.safeMode ? 'Safe reads on' : 'SAFE mode off'}
                  className={`context-chip ${settings.safeMode ? 'safe' : 'warning'}`}
                  title={settings.safeMode ? 'Safe reads on' : 'SAFE mode off'}
                >
                  <ShieldCheck size={14} />
                  <span className="context-label">{settings.safeMode ? 'Safe reads on' : 'SAFE mode off'}</span>
                </span>
              </div>
            </div>
            <div className="chat-status" title={status}>
              <Sparkles size={14} />
              <span>{status}</span>
            </div>
          </div>
        </header>

        <div className="messages">
          {hasOnlyWelcomeMessage && (
            <section className="welcome-panel" aria-label="Starter prompts">
              <div>
                <h3>Ask about the data.</h3>
                <p>
                  {settings.safeMode
                    ? 'Connect a database and DB Chat will run safe read-only analysis from the conversation.'
                    : 'Connect a database and DB Chat will run validated reads and table or document writes from the conversation.'}
                </p>
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
          {!hasOnlyWelcomeMessage && messages.map((message) => (
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
            <div className="composer-meta">
              <span>{connection ? connection.label : 'SQLite connection needed'}</span>
              <span>{prompt.length} / 3,000</span>
            </div>
            <button type="submit" disabled={busy || !prompt.trim()} aria-label="Send message">
              <Send size={18} />
            </button>
          </div>
        </form>
          </>
        )}
      </section>

      {rightPanelCollapsed ? (
        <aside className="panel-rail inspector-rail" id="inspector-sidebar" aria-label="Collapsed inspector sidebar">
          <button
            aria-label="Expand inspector sidebar"
            className="panel-rail-button"
            onClick={() => setRightPanelCollapsed(false)}
            title="Expand inspector sidebar"
            type="button"
          >
            <PanelRightOpen size={18} />
          </button>
        </aside>
      ) : (
        <aside className="inspector" id="inspector-sidebar" aria-label="Inspector">
          <header className="inspector-header">
            <div className="inspector-heading-row">
              <div>
                <p>
                  {activeInspector === 'results'
                    ? 'Executed output'
                    : activeInspector === 'query'
                      ? 'Generated SQL'
                      : 'Database map'}
                </p>
                <h2>{activeInspector === 'results' ? 'Results' : activeInspector === 'query' ? 'Query' : 'Schema'}</h2>
              </div>
              <button
                aria-label="Collapse inspector sidebar"
                className="panel-collapse-button"
                onClick={() => setRightPanelCollapsed(true)}
                title="Collapse inspector sidebar"
                type="button"
              >
                <PanelRightClose size={18} />
              </button>
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
      )}

      {!rightPanelCollapsed && (
        <div
          aria-controls="inspector-sidebar"
          aria-label="Resize inspector sidebar"
          aria-orientation="vertical"
          aria-valuemax={rightPanelMaxWidth}
          aria-valuemin={rightPanelMinWidth}
          aria-valuenow={Math.round(rightPanelWidth)}
          className="panel-resize-handle right"
          onDoubleClick={() => setRightPanelWidth(rightPanelDefaultWidth)}
          onKeyDown={(event) => resizePanelWithKeyboard('right', event)}
          onPointerDown={(event) => beginPanelResize('right', event)}
          role="separator"
          tabIndex={0}
        />
      )}

    </main>
  );
}
