import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  ArrowUp,
  KeyRound,
  List,
  Loader2,
  MessageSquareText,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Search,
  Sun,
  Table2,
  Trash2
} from 'lucide-react';
import {
  FormEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  siElasticsearch,
  siMongodb,
  siMysql,
  siPostgresql,
  siSqlite,
  type SimpleIcon
} from 'simple-icons';
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
  QueryValidationResult,
  TableInfo
} from '../shared/types';

const fallbackApi = typeof window !== 'undefined' ? window.dbchat : undefined;
const themeStorageKey = 'dbchat:theme';

type InspectorTab = 'results' | 'query' | 'schema';
type AppView = 'workspace' | 'connections' | 'history' | 'settings';
type ConnectionLogoKind = 'sqlite' | 'elasticsearch' | 'mysql' | 'postgres' | 'mongodb';
type SchemaViewMode = 'pro' | 'raw';
type ThemeMode =
  | 'light' | 'dark'
  | 'catppuccin-latte' | 'solarized-light' | 'rose-pine-dawn'
  | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha'
  | 'nord' | 'tokyo-night' | 'dracula' | 'gruvbox-dark' | 'monokai' | 'rose-pine';

interface ThemeEntry {
  id: ThemeMode;
  label: string;
  group: 'light' | 'dark';
}

const themeRegistry: ThemeEntry[] = [
  { id: 'light',               label: 'Light',              group: 'light' },
  { id: 'catppuccin-latte',    label: 'Catppuccin Latte',   group: 'light' },
  { id: 'solarized-light',     label: 'Solarized Light',    group: 'light' },
  { id: 'rose-pine-dawn',      label: 'Rose Pine Dawn',     group: 'light' },
  { id: 'dark',                label: 'Dark',               group: 'dark'  },
  { id: 'catppuccin-frappe',   label: 'Catppuccin Frappe',  group: 'dark'  },
  { id: 'catppuccin-macchiato',label: 'Catppuccin Macchiato',group: 'dark'  },
  { id: 'catppuccin-mocha',    label: 'Catppuccin Mocha',   group: 'dark'  },
  { id: 'nord',                label: 'Nord',               group: 'dark'  },
  { id: 'tokyo-night',         label: 'Tokyo Night',        group: 'dark'  },
  { id: 'dracula',             label: 'Dracula',            group: 'dark'  },
  { id: 'gruvbox-dark',        label: 'Gruvbox Dark',       group: 'dark'  },
  { id: 'monokai',             label: 'Monokai',            group: 'dark'  },
  { id: 'rose-pine',           label: 'Rose Pine',          group: 'dark'  },
];

const validThemeIds = new Set<string>(themeRegistry.map((entry) => entry.id));
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

const schemaFieldGroups = [
  'Identity',
  'Links',
  'Dates',
  'Amounts',
  'Status',
  'Text',
  'Other'
] as const;

type SchemaFieldGroup = typeof schemaFieldGroups[number];

const initialAssistantMessage = 'Connect a database to start asking questions about your data.';

const connectionLogos: Record<ConnectionLogoKind, SimpleIcon> = {
  sqlite: siSqlite,
  elasticsearch: siElasticsearch,
  mysql: siMysql,
  postgres: siPostgresql,
  mongodb: siMongodb
};

function nowMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

function schemaObjectKind(kind?: DatabaseSchema['kind']): string {
  if (kind === 'elasticsearch') return 'index';
  if (kind === 'mongodb') return 'collection';
  return 'table';
}

function schemaObjectPlural(kind?: DatabaseSchema['kind']): string {
  if (kind === 'elasticsearch') return 'indices';
  if (kind === 'mongodb') return 'collections';
  return 'tables';
}

function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (!words.length) {
    return value;
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function schemaSearchText(table: TableInfo): string {
  return [
    table.name,
    humanizeIdentifier(table.name),
    ...table.columns.flatMap((column) => [
      column.name,
      humanizeIdentifier(column.name),
      column.type,
      fieldGroup(column)
    ])
  ].join(' ').toLowerCase();
}

function isIdentityOrLinkField(column: { name: string; primaryKey: boolean }): boolean {
  const name = column.name.toLowerCase();
  return column.primaryKey
    || name === 'id'
    || name === '_id'
    || name.endsWith('_id')
    || name.endsWith('id')
    || name.includes('uuid')
    || name.includes('email');
}

function sortSchemaColumns(columns: TableInfo['columns']): TableInfo['columns'] {
  return [...columns].sort((a, b) => {
    if (a.primaryKey !== b.primaryKey) return a.primaryKey ? -1 : 1;
    const aLink = isIdentityOrLinkField(a);
    const bLink = isIdentityOrLinkField(b);
    if (aLink !== bLink) return aLink ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function sortSchemaTables(tables: TableInfo[]): TableInfo[] {
  return [...tables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((table) => ({
      ...table,
      columns: sortSchemaColumns(table.columns)
    }));
}

function fieldGroup(column: TableInfo['columns'][number]): SchemaFieldGroup {
  const name = column.name.toLowerCase();
  const type = column.type.toLowerCase();

  if (column.primaryKey || name === 'id' || name === '_id' || name.includes('uuid') || name.includes('email')) {
    return 'Identity';
  }
  if (name.endsWith('_id') || name.endsWith('id') || name.includes('customer') || name.includes('user')) {
    return 'Links';
  }
  if (name.includes('date') || name.includes('time') || name.includes('created') || name.includes('updated') || type.includes('date') || type.includes('time')) {
    return 'Dates';
  }
  if (name.includes('amount') || name.includes('price') || name.includes('total') || name.includes('cost') || name.includes('revenue') || name.includes('count') || /int|double|float|decimal|number|numeric/.test(type)) {
    return 'Amounts';
  }
  if (name.includes('status') || name.includes('state') || name.includes('type') || name.includes('category') || name.includes('kind')) {
    return 'Status';
  }
  if (name.includes('name') || name.includes('title') || name.includes('description') || name.includes('comment') || name.includes('note') || name.includes('text') || /char|text|string|keyword/.test(type)) {
    return 'Text';
  }
  return 'Other';
}

function groupedSchemaFields(columns: TableInfo['columns']): Array<{ group: SchemaFieldGroup; fields: TableInfo['columns'] }> {
  return schemaFieldGroups
    .map((group) => ({
      group,
      fields: columns.filter((column) => fieldGroup(column) === group)
    }))
    .filter((entry) => entry.fields.length > 0);
}

function schemaFieldPreview(columns: TableInfo['columns'], mode: SchemaViewMode): string {
  const labels = columns.slice(0, 6).map((column) => mode === 'pro' ? humanizeIdentifier(column.name) : column.name);
  const suffix = columns.length > labels.length ? `, +${columns.length - labels.length} more` : '';
  return labels.length ? `${labels.join(', ')}${suffix}` : 'No fields found';
}

function schemaStarterPrompts(label: string, kind: string): string[] {
  return [
    `What can I ask about ${label}?`,
    `Summarize ${label}.`,
    `Find data quality issues in ${label}.`
  ].map((prompt) => kind === 'index' ? prompt.replace('data quality issues', 'unusual patterns') : prompt);
}

function ConnectionLogo({ kind }: { kind: ConnectionLogoKind }) {
  const icon = connectionLogos[kind];
  return (
    <svg aria-hidden="true" className="connection-logo" viewBox="0 0 24 24">
      <path d={icon.path} fill={`#${icon.hex}`} />
    </svg>
  );
}

function loadInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }
  const stored = window.localStorage.getItem(themeStorageKey);
  return stored && validThemeIds.has(stored) ? stored as ThemeMode : 'light';
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

function defaultPort(kind: 'mysql' | 'postgres' | 'mongodb'): string {
  switch (kind) {
    case 'mysql': return '3306';
    case 'postgres': return '5432';
    case 'mongodb': return '27017';
  }
}

function dbKindLabel(kind: 'mysql' | 'postgres' | 'mongodb'): string {
  switch (kind) {
    case 'mysql': return 'MySQL';
    case 'postgres': return 'PostgreSQL';
    case 'mongodb': return 'MongoDB';
  }
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
  const [schemaViewMode, setSchemaViewMode] = useState<SchemaViewMode>('pro');
  const [schemaSearch, setSchemaSearch] = useState('');
  const [expandedSchemaItems, setExpandedSchemaItems] = useState<Record<string, boolean>>({});
  const [schemaScrolled, setSchemaScrolled] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(loadInitialTheme);
  const [elasticsearchFormOpen, setElasticsearchFormOpen] = useState(false);
  const [elasticsearchHost, setElasticsearchHost] = useState('localhost');
  const [elasticsearchPort, setElasticsearchPort] = useState('9200');
  const [elasticsearchUseSsl, setElasticsearchUseSsl] = useState(false);
  const [elasticsearchVerifyCerts, setElasticsearchVerifyCerts] = useState(true);
  const [elasticsearchUsername, setElasticsearchUsername] = useState('');
  const [elasticsearchPassword, setElasticsearchPassword] = useState('');
  const [elasticsearchRememberPassword, setElasticsearchRememberPassword] = useState(false);
  const [dbFormOpen, setDbFormOpen] = useState(false);
  const [dbFormKind, setDbFormKind] = useState<'mysql' | 'postgres' | 'mongodb'>('mysql');
  const [dbFormHost, setDbFormHost] = useState('localhost');
  const [dbFormPort, setDbFormPort] = useState('3306');
  const [dbFormDatabase, setDbFormDatabase] = useState('');
  const [dbFormUsername, setDbFormUsername] = useState('');
  const [dbFormPassword, setDbFormPassword] = useState('');
  const [dbFormSsl, setDbFormSsl] = useState(false);
  const [dbFormRememberPassword, setDbFormRememberPassword] = useState(false);
  const [dbFormAuthDatabase, setDbFormAuthDatabase] = useState('');
  const [rightPanelWidth, setRightPanelWidth] = useState(rightPanelDefaultWidth);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const recentChatsRef = useRef<HTMLDivElement | null>(null);
  const schemaPanelRef = useRef<HTMLElement | null>(null);
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
    setSchemaSearch('');
    setExpandedSchemaItems({});
    setSchemaScrolled(false);
    if (schemaPanelRef.current) {
      schemaPanelRef.current.scrollTop = 0;
    }
  }, [schema]);

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
    if (!recentChatsOpen) {
      return;
    }

    function closeRecentChats(event: PointerEvent) {
      if (event.target instanceof Node && recentChatsRef.current?.contains(event.target)) {
        return;
      }
      setRecentChatsOpen(false);
    }

    window.addEventListener('pointerdown', closeRecentChats);
    return () => window.removeEventListener('pointerdown', closeRecentChats);
  }, [recentChatsOpen]);

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
      : schema.kind === 'mongodb'
      ? (schema.tables.length === 1 ? 'collection' : 'collections')
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

  const schemaTables = useMemo(() => sortSchemaTables(schema?.tables ?? []), [schema]);
  const filteredSchemaTables = useMemo(() => {
    const search = schemaSearch.trim().toLowerCase();
    if (!search) {
      return schemaTables;
    }
    return schemaTables.filter((table) => schemaSearchText(table).includes(search));
  }, [schemaSearch, schemaTables]);
  const schemaSearchActive = schemaSearch.trim().length > 0;
  const allSchemaItemsExpanded = filteredSchemaTables.length > 0
    && filteredSchemaTables.every((table) => expandedSchemaItems[table.name]);

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
    setElasticsearchFormOpen(false);
    setDbFormOpen(false);
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
    if ((config.kind === 'mysql' || config.kind === 'postgres' || config.kind === 'mongodb')
      && config.username
      && !config.password && !config.hasSavedPassword) {
      prepareDbReconnect(config, config.kind, `Enter the password to reconnect ${config.label}.`);
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
      if ((session.connection.kind === 'mysql' || session.connection.kind === 'postgres' || session.connection.kind === 'mongodb')
        && session.connection.username
        && !session.connection.password
        && !session.connection.hasSavedPassword) {
        prepareDbReconnect(session.connection, session.connection.kind, `Opened ${session.title}. Enter the password to reconnect ${session.connection.label}.`);
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

  async function clearChatHistory() {
    if (!api || !chatSessions.length) return;
    await api.clearChatSessions();
    setActiveChatId(null);
    setMessages(createInitialMessages());
    setPrompt('');
    setQuery('');
    setValidation(null);
    setResult(null);
    setActiveInspector('schema');
    setRecentChatsOpen(false);
    await refreshHistories();
    updateStatus('Chat history cleared');
  }

  async function deleteConnection(id: string) {
    if (!api) return;
    await api.deleteConnection(id);
    await refreshHistories();
    updateStatus('Saved connection deleted');
  }

  function prepareElasticsearchReconnect(config: ConnectionConfig, nextStatus: string) {
    const values = elasticsearchHistoryValues(config);
    setDbFormOpen(false);
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

  function openElasticsearchForm() {
    setDbFormOpen(false);
    setElasticsearchFormOpen((current) => !current);
  }

  function openDbForm(kind: 'mysql' | 'postgres' | 'mongodb') {
    setElasticsearchFormOpen(false);
    setDbFormKind(kind);
    setDbFormHost('localhost');
    setDbFormPort(defaultPort(kind));
    setDbFormDatabase('');
    setDbFormUsername('');
    setDbFormPassword('');
    setDbFormSsl(false);
    setDbFormRememberPassword(false);
    setDbFormAuthDatabase('');
    setDbFormOpen(true);
  }

  function prepareDbReconnect(config: ConnectionConfig, kind: 'mysql' | 'postgres' | 'mongodb', nextStatus: string) {
    setElasticsearchFormOpen(false);
    setDbFormKind(kind);
    setDbFormHost(config.host ?? 'localhost');
    setDbFormPort(String(config.port ?? Number(defaultPort(kind))));
    setDbFormDatabase(config.database ?? '');
    setDbFormUsername(config.username ?? '');
    setDbFormPassword('');
    setDbFormSsl(Boolean(config.ssl));
    setDbFormRememberPassword(Boolean(config.hasSavedPassword || config.rememberPassword));
    setDbFormAuthDatabase(config.authDatabase ?? '');
    setDbFormOpen(true);
    updateStatus(nextStatus);
  }

  async function connectDb(event?: FormEvent) {
    event?.preventDefault();
    if (!api) {
      updateStatus('Database connections are available in the Electron desktop app.');
      return;
    }
    if (!dbFormHost.trim()) {
      updateStatus('Enter a host before connecting.');
      return;
    }
    const port = Number(dbFormPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      updateStatus('Enter a valid port (1-65535).');
      return;
    }

    setBusy(true);
    updateStatus(`Connecting to ${dbKindLabel(dbFormKind)}...`);
    try {
      const config: ConnectionConfig = {
        id: crypto.randomUUID(),
        kind: dbFormKind,
        label: `${dbFormKind} ${dbFormHost.trim()}:${port}${dbFormDatabase ? `/${dbFormDatabase}` : ''}`,
        host: dbFormHost.trim(),
        port,
        database: dbFormDatabase.trim() || undefined,
        username: dbFormUsername.trim() || undefined,
        password: dbFormPassword || undefined,
        ssl: dbFormSsl,
        rememberPassword: dbFormRememberPassword,
        ...(dbFormKind === 'mongodb' ? { authDatabase: dbFormAuthDatabase.trim() || undefined } : {}),
        createdAt: new Date().toISOString()
      };
      const nextSchema = await api.connect(config);
      setConnection(config);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setActiveView('workspace');
      setDbFormOpen(false);
      const tableLabel = dbFormKind === 'mongodb' ? 'collections' : 'tables';
      setMessages((current) => [
        ...current,
        nowMessage('assistant', `Connected to ${config.label}. I found ${nextSchema.tables.length} ${tableLabel}.`)
      ]);
      updateStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      reportError(`Could not connect to ${dbKindLabel(dbFormKind)}.`, error);
    } finally {
      setBusy(false);
    }
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

  function chooseSchemaPrompt(starterPrompt: string) {
    setPrompt(starterPrompt);
    setActiveView('workspace');
  }

  function toggleSchemaItem(name: string) {
    setExpandedSchemaItems((current) => ({
      ...current,
      [name]: !current[name]
    }));
  }

  function toggleAllSchemaItems() {
    setExpandedSchemaItems((current) => {
      const next = { ...current };
      for (const table of filteredSchemaTables) {
        next[table.name] = !allSchemaItemsExpanded;
      }
      return next;
    });
  }

  function handleSchemaScroll(event: ReactUIEvent<HTMLElement>) {
    setSchemaScrolled(event.currentTarget.scrollTop > 80);
  }

  function scrollSchemaToTop() {
    const panel = schemaPanelRef.current;
    if (!panel) return;
    panel.scrollTo?.({ top: 0, behavior: 'smooth' });
    if (!panel.scrollTo) {
      panel.scrollTop = 0;
    }
    setSchemaScrolled(false);
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
              placeholder={connection?.kind === 'elasticsearch' || connection?.kind === 'mongodb' ? 'Generated JSON will appear here.' : 'Generated SQL will appear here.'}
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
      <section className="inspector-body schema-panel" aria-label="Schema" onScroll={handleSchemaScroll} ref={schemaPanelRef}>
        {schema ? (
          <>
            <div className="schema-summary">
              <Database size={18} />
              <div>
                <strong>{connection?.label ?? schema.label ?? 'Database'}</strong>
                <span>{schemaSummary}</span>
              </div>
            </div>
            <div className="schema-toolbar">
              <label className="schema-search">
                <Search size={14} />
                <input
                  aria-label="Search schema"
                  onChange={(event) => setSchemaSearch(event.target.value)}
                  placeholder={`Search ${schemaObjectPlural(schema.kind)} or fields`}
                  type="search"
                  value={schemaSearch}
                />
              </label>
              <div className="schema-view-toggle" aria-label="Schema view">
                {(['pro', 'raw'] as const).map((mode) => (
                  <button
                    aria-pressed={schemaViewMode === mode}
                    className={schemaViewMode === mode ? 'active' : ''}
                    key={mode}
                    onClick={() => setSchemaViewMode(mode)}
                    type="button"
                  >
                    {mode === 'pro' ? 'Pro' : 'Raw'}
                  </button>
                ))}
              </div>
              {!schemaSearchActive && filteredSchemaTables.length > 0 && (
                <button type="button" className="schema-expand-all" onClick={toggleAllSchemaItems}>
                  {allSchemaItemsExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
            {filteredSchemaTables.length ? (
              <div className="schema-list">
                {filteredSchemaTables.map((table) => {
                  const objectKind = schemaObjectKind(schema.kind);
                  const friendlyName = humanizeIdentifier(table.name);
                  const displayName = schemaViewMode === 'pro' ? friendlyName : table.name;
                  const expanded = schemaSearchActive || Boolean(expandedSchemaItems[table.name]);
                  return (
                    <article className={`schema-card ${expanded ? 'expanded' : ''}`} key={table.name}>
                      <button
                        aria-expanded={expanded}
                        className="schema-card-header"
                        onClick={() => toggleSchemaItem(table.name)}
                        type="button"
                      >
                        <ChevronDown size={15} />
                        <span>
                          <strong>{displayName}</strong>
                          {schemaViewMode === 'pro' && table.name !== friendlyName && <small>{table.name}</small>}
                        </span>
                        <em>{objectKind}</em>
                        <b>{table.columns.length} {table.columns.length === 1 ? 'field' : 'fields'}</b>
                      </button>
                      <p>{schemaFieldPreview(table.columns, schemaViewMode)}</p>
                      {expanded && (
                        <div className="schema-card-detail">
                          {schemaViewMode === 'pro' ? (
                            <>
                              <div className="schema-prompt-row">
                                {schemaStarterPrompts(friendlyName, objectKind).map((starterPrompt) => (
                                  <button type="button" onClick={() => chooseSchemaPrompt(starterPrompt)} key={starterPrompt}>
                                    {starterPrompt}
                                  </button>
                                ))}
                              </div>
                              {groupedSchemaFields(table.columns).map((group) => (
                                <section className="schema-field-group" key={group.group}>
                                  <h3>{group.group}</h3>
                                  <div className="schema-field-list">
                                    {group.fields.map((column) => (
                                      <div className="schema-field-row" key={column.name}>
                                        <span>
                                          <strong>{humanizeIdentifier(column.name)}</strong>
                                          <small>{column.name}</small>
                                        </span>
                                        <em>{column.type}</em>
                                        {column.primaryKey && <b>Primary</b>}
                                      </div>
                                    ))}
                                  </div>
                                </section>
                              ))}
                            </>
                          ) : (
                            <div className="schema-field-list raw">
                              {table.columns.map((column) => (
                                <div className="schema-field-row" key={column.name}>
                                  <span>
                                    <strong>{column.name}</strong>
                                    <small>{fieldGroup(column)}</small>
                                  </span>
                                  <em>{column.type}</em>
                                  {column.primaryKey && <b>Primary</b>}
                                  <b>{column.nullable ? 'Nullable' : 'Required'}</b>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state schema-empty">
                <Search size={22} />
                <span>No schema matches found.</span>
              </div>
            )}
            {schemaScrolled && (
              <button
                aria-label="Return to top of schema"
                className="schema-return-top"
                onClick={scrollSchemaToTop}
                type="button"
              >
                <ArrowUp size={14} />
                Top
              </button>
            )}
          </>
        ) : (
          <div className="empty-state">
            <Database size={22} />
            <span>Connect a database to inspect its schema.</span>
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

  function renderDbForm() {
    if (!dbFormOpen) {
      return null;
    }

    const label = dbKindLabel(dbFormKind);

    return (
      <form className="elasticsearch-form" aria-label={`${label} connection`} onSubmit={(event) => void connectDb(event)}>
        <label>
          <span>Host</span>
          <input
            value={dbFormHost}
            onChange={(event) => setDbFormHost(event.target.value)}
            placeholder="localhost"
          />
        </label>
        <label>
          <span>Port</span>
          <input
            value={dbFormPort}
            onChange={(event) => setDbFormPort(event.target.value)}
            inputMode="numeric"
            type="number"
            min={1}
            max={65535}
          />
        </label>
        <label>
          <span>Database</span>
          <input value={dbFormDatabase} onChange={(event) => setDbFormDatabase(event.target.value)} placeholder="mydb" />
        </label>
        <label>
          <span>Username</span>
          <input value={dbFormUsername} onChange={(event) => setDbFormUsername(event.target.value)} />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={dbFormPassword} onChange={(event) => setDbFormPassword(event.target.value)} />
        </label>
        {dbFormKind === 'mongodb' && (
          <label>
            <span>Auth database</span>
            <input value={dbFormAuthDatabase} onChange={(event) => setDbFormAuthDatabase(event.target.value)} placeholder="admin" />
          </label>
        )}
        <label className="elasticsearch-checkbox">
          <input type="checkbox" checked={dbFormSsl} onChange={(event) => setDbFormSsl(event.target.checked)} />
          <span>Use SSL/TLS</span>
        </label>
        <label className="elasticsearch-checkbox">
          <input
            type="checkbox"
            checked={dbFormRememberPassword}
            onChange={(event) => setDbFormRememberPassword(event.target.checked)}
          />
          <span>Remember password</span>
        </label>
        <button type="submit" className="primary-button" disabled={busy || !dbFormHost.trim() || !dbFormPort.trim()}>
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
                  <ConnectionLogo kind="sqlite" />
                  SQLite
                </button>
                <button type="button" className="secondary-button" onClick={openElasticsearchForm} disabled={busy || !api}>
                  <ConnectionLogo kind="elasticsearch" />
                  Elasticsearch
                </button>
                <button type="button" className="secondary-button" onClick={() => openDbForm('mysql')} disabled={busy || !api}>
                  <ConnectionLogo kind="mysql" />
                  MySQL
                </button>
                <button type="button" className="secondary-button" onClick={() => openDbForm('postgres')} disabled={busy || !api}>
                  <ConnectionLogo kind="postgres" />
                  PostgreSQL
                </button>
                <button type="button" className="secondary-button" onClick={() => openDbForm('mongodb')} disabled={busy || !api}>
                  <ConnectionLogo kind="mongodb" />
                  MongoDB
                </button>
              </div>
              {renderElasticsearchForm()}
              {renderDbForm()}
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
            <div className="focus-header-actions">
              <button type="button" className="secondary-button" onClick={() => void clearChatHistory()} disabled={!chatSessions.length || !api}>
                <Trash2 size={16} />
                Clear all
              </button>
              <button type="button" className="primary-button" onClick={resetChat}>
                <Plus size={16} />
                New chat
              </button>
            </div>
          </header>
          <section className="focus-panel history-section">{renderChatHistory()}</section>
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
            <div className="theme-picker" aria-label="Theme">
              {(['light', 'dark'] as const).map((group) => {
                const groupThemes = themeRegistry.filter((entry) => entry.group === group);
                const selectedId = groupThemes.some((entry) => entry.id === theme)
                  ? theme
                  : groupThemes[0]?.id ?? theme;
                return (
                  <div className="theme-group" key={group}>
                    <div className="theme-group-label">
                      {group === 'light' ? <Sun size={14} /> : <Moon size={14} />}
                      <span>{group === 'light' ? 'Light' : 'Dark'}</span>
                    </div>
                    <select
                      className="theme-select"
                      value={selectedId}
                      onChange={(event) => setTheme(event.target.value as ThemeMode)}
                      aria-label={`${group === 'light' ? 'Light' : 'Dark'} theme`}
                    >
                      {groupThemes.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.label}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
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
            <div className="recent-anchor" ref={recentChatsRef}>
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
                      ? `Generated ${connection?.kind === 'elasticsearch' || connection?.kind === 'mongodb' ? 'JSON' : 'SQL'}`
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
