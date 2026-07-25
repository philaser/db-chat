import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Download,
  Loader2,
  MessageSquareText,
  Moon,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Table2,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
import {
  FormEvent,
  useCallback,
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
  AuditEntry,
  ChatMessage,
  ChatActivityStep,
  ConnectionConfig,
  ConnectionHistoryItem,
  DatabaseSchema,
  EffortLevel,
  ModelChatMessage,
  ModelInfo,
  ModelProviderKind,
  PersistedChatSession,
  PersistedSettings,
  QueryResult,
  SafetyLevel,
  TableInfo
} from '../shared/types';

const fallbackApi = typeof window !== 'undefined' ? window.dbchat : undefined;
const themeStorageKey = 'dbchat:theme';

type InspectorTab = 'results' | 'query' | 'schema' | 'audit';
type AppView = 'workspace' | 'history' | 'settings';
type SidebarMode = 'projects' | 'project';
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
const rightPanelDefaultWidth = 384;
const rightPanelMinWidth = 320;
const rightPanelMaxWidth = 480;
const chatPaneMinWidth = 560;
const keyboardResizeStep = 24;
const constrainedBreakpoint = 1180;

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

function ConnectionLogo({ kind, monochrome = false }: { kind: ConnectionLogoKind; monochrome?: boolean }) {
  const icon = connectionLogos[kind];
  return (
    <svg aria-hidden="true" className="connection-logo" viewBox="0 0 24 24">
      <path d={icon.path} fill={monochrome ? 'currentColor' : `#${icon.hex}`} />
    </svg>
  );
}

const connectionKindOptions: { kind: ConnectionLogoKind; label: string }[] = [
  { kind: 'sqlite', label: 'SQLite' },
  { kind: 'elasticsearch', label: 'Elasticsearch' },
  { kind: 'mysql', label: 'MySQL' },
  { kind: 'postgres', label: 'PostgreSQL' },
  { kind: 'mongodb', label: 'MongoDB' },
];

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

function dbKindDisplayName(kind: string): string {
  switch (kind) {
    case 'sqlite': return 'SQLite';
    case 'mysql': return 'MySQL';
    case 'postgres': return 'PostgreSQL';
    case 'mongodb': return 'MongoDB';
    case 'elasticsearch': return 'Elasticsearch';
    default: return kind;
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

function activitySummary(activity: ChatActivityStep[], generating: boolean): string {
  if (!activity.length) {
    return generating ? 'Preparing answer...' : 'No database checks needed';
  }
  const completedQueries = activity.filter((step) => step.status === 'success').length;
  const blockedQueries = activity.filter((step) => step.status === 'blocked' || step.status === 'error').length;
  const elapsed = activity.reduce((sum, step) => sum + (step.elapsedMs ?? 0), 0);
  if (generating) {
    return activity.at(-1)?.title ?? 'Working...';
  }
  if (completedQueries) {
    return `Checked ${completedQueries} quer${completedQueries === 1 ? 'y' : 'ies'}${elapsed ? ` in ${elapsed} ms` : ''}`;
  }
  if (blockedQueries) {
    return `${blockedQueries} query ${blockedQueries === 1 ? 'was' : 'were'} blocked or failed`;
  }
  return activity.at(-1)?.title ?? 'Answer ready';
}

function activityIcon(step: ChatActivityStep) {
  if (step.status === 'success' || step.status === 'complete') {
    return <CheckCircle2 size={14} />;
  }
  if (step.status === 'blocked' || step.status === 'error') {
    return <XCircle size={14} />;
  }
  if (step.status === 'running' || step.status === 'thinking') {
    return <Loader2 className="message-spinner" size={14} />;
  }
  return <Clock3 size={14} />;
}

function mergeActivityStep(activity: ChatActivityStep[], step: ChatActivityStep): ChatActivityStep[] {
  const existingIndex = step.queryId
    ? activity.findIndex((current) => current.queryId === step.queryId)
    : activity.findIndex((current) => !current.queryId && current.title === step.title);
  if (existingIndex < 0) {
    const next = [...activity, step];
    return next;
  }
  const next = activity.map((current, index) => index === existingIndex ? { ...current, ...step } : current);
  return next;
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso));
}

export function App({ api = fallbackApi }: { api?: typeof window.dbchat }) {
  const [connection, setConnection] = useState<ConnectionConfig | null>(null);
  const [schema, setSchema] = useState<DatabaseSchema | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(createInitialMessages);
  const [prompt, setPrompt] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [chatSessions, setChatSessions] = useState<PersistedChatSession[]>([]);
  const [savedConnections, setSavedConnections] = useState<ConnectionHistoryItem[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [settings, setSettings] = useState<PersistedSettings & { hasApiKey: boolean }>({
    provider: 'openrouter',
    model: 'openai/gpt-4.1-mini',
    hasApiKey: false
  });
  const [activeView, setActiveView] = useState<AppView>('workspace');
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('projects');
  const [activeProject, setActiveProject] = useState<ConnectionConfig | null>(null);
  const [showFlyoutChats, setShowFlyoutChats] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<AppLogEntry[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState(settings.model);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [answerGenerating, setAnswerGenerating] = useState(false);
  const [chatActivity, setChatActivity] = useState<ChatActivityStep[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [messageActivities, setMessageActivities] = useState<Record<string, ChatActivityStep[]>>({});
  const [messageActivityOpen, setMessageActivityOpen] = useState<Record<string, boolean>>({});
  const [activeInspector, setActiveInspector] = useState<InspectorTab>('schema');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [schemaViewMode, setSchemaViewMode] = useState<SchemaViewMode>('pro');
  const [schemaSearch, setSchemaSearch] = useState('');
  const [expandedSchemaItems, setExpandedSchemaItems] = useState<Record<string, boolean>>({});
  const [schemaScrolled, setSchemaScrolled] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(loadInitialTheme);
  const [connectionKindMenuOpen, setConnectionKindMenuOpen] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [connectingProjectId, setConnectingProjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
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
  const [resizeDrag, setResizeDrag] = useState<ResizeDrag | null>(null);
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [pendingApproval, setPendingApproval] = useState<{
    id: string;
    toolName: string;
    purpose: string;
    queryPreview?: string;
    risk: 'none' | 'low' | 'medium' | 'high';
  } | null>(null);
  const [auditEntries, setAuditEntries] = useState<Array<{ id: string; timestamp: string; toolName: string; permissionDecision: string; queryPreview?: string; risk?: string }>>([]);
  const [effortLevel, setEffortLevel] = useState<EffortLevel>('medium');
  const [safetyLevel, setSafetyLevelState] = useState<SafetyLevel>('standard');
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const recentChatsRef = useRef<HTMLDivElement | null>(null);
  const schemaPanelRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const activeChatTurnIdRef = useRef<string | null>(null);

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
    if (connection?.safetyLevel) {
      setSafetyLevelState(connection.safetyLevel);
    }
  }, [connection?.id, connection?.safetyLevel]);

  useEffect(() => {
    if (!api) {
      updateStatus('Desktop app bridge unavailable. Run DB Chat in Electron to connect databases.');
      return;
    }
    void api.loadSettings().then((s) => { setSettings(s); if (s.effortLevel) setEffortLevel(s.effortLevel); }).catch((error) => reportError('Settings could not be loaded. Defaults are in use.', error));
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
    void api.listModels()
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
    if (!openDropdown) return;
    function handlePointerDown(event: PointerEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openDropdown]);

  useEffect(() => {
    setSchemaSearch('');
    setExpandedSchemaItems({});
    setSchemaScrolled(false);
    if (schemaPanelRef.current) {
      schemaPanelRef.current.scrollTop = 0;
    }
  }, [schema]);

  function scrollMessagesToEnd() {
    const messagesElement = messagesRef.current;
    if (messagesElement) {
      messagesElement.scrollTo({ top: messagesElement.scrollHeight, behavior: 'auto' });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }

  useEffect(() => {
    scrollMessagesToEnd();
    const frame = window.requestAnimationFrame(() => scrollMessagesToEnd());
    const shortTimer = window.setTimeout(() => scrollMessagesToEnd(), 80);
    const transitionTimer = window.setTimeout(() => scrollMessagesToEnd(), 280);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(shortTimer);
      window.clearTimeout(transitionTimer);
    };
  }, [messages, answerGenerating, chatActivity, activityOpen]);

  useEffect(() => {
    if (!showFlyoutChats) {
      return;
    }

    function closeFlyout(event: PointerEvent) {
      if (event.target instanceof Node && recentChatsRef.current?.contains(event.target)) {
        return;
      }
      setShowFlyoutChats(false);
    }

    window.addEventListener('pointerdown', closeFlyout);
    return () => window.removeEventListener('pointerdown', closeFlyout);
  }, [showFlyoutChats]);

  useEffect(() => {
    if (!connectionKindMenuOpen) {
      return;
    }

    function closeMenu(event: PointerEvent) {
      const target = event.target as Node;
      if (!target || !(target instanceof Node)) {
        return;
      }
      const root = document.querySelector('.connection-kind-select');
      if (root && !root.contains(target)) {
        setConnectionKindMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setConnectionKindMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [connectionKindMenuOpen]);

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
    const q = modelSearch.trim().toLowerCase();
    if (!q) {
      return models;
    }
    return models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(q));
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
  const isConstrained = typeof window !== 'undefined' && window.innerWidth < constrainedBreakpoint;
  const isProjectPage = sidebarMode === 'project' && activeChatId === null && activeView === 'workspace';

  useEffect(() => {
    if (isProjectPage) {
      setActiveInspector('schema');
      setInspectorOpen(true);
    }
  }, [isProjectPage]);

  // TSV serialization for Copy
  function serializeResultAsTsv(result: QueryResult): string {
    const header = result.columns.join('\t');
    const rows = result.rows.map((row) =>
      result.columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes('\t') || str.includes('\n') || str.includes('"')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join('\t')
    );
    return [header, ...rows].join('\n');
  }

  // CSV serialization for export
  function serializeResultAsCsv(result: QueryResult): string {
    function quoteField(value: string): string {
      if (value.includes(',') || value.includes('"') || value.includes('\r') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }
    const header = result.columns.map(quoteField).join(',');
    const rows = result.rows.map((row) =>
      result.columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        return quoteField(String(val));
      }).join(',')
    );
    return '\uFEFF' + [header, ...rows].join('\r\n');
  }

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
    setActiveChatId(crypto.randomUUID());
    setMessages(createInitialMessages());
    setPrompt('');
    setQuery('');
    setResult(null);
    setChatActivity([]);
    setActivityOpen(false);
    setMessageActivities({});
    setMessageActivityOpen({});
    setActiveInspector('schema');
    setActiveView('workspace');
    setShowFlyoutChats(false);
    updateStatus('Ready for a new chat');
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function closeProject() {
    setConnection(null);
    setSchema(null);
    setActiveProject(null);
    setSidebarMode('projects');
    setActiveChatId(null);
    setMessages(createInitialMessages());
    setPrompt('');
    setQuery('');
    setResult(null);
    setChatActivity([]);
    setActivityOpen(false);
    setMessageActivities({});
    setMessageActivityOpen({});
    setActiveInspector('schema');
    setInspectorOpen(false);
    setActiveView('workspace');
    setShowFlyoutChats(false);
    updateStatus('Closed project');
  }

  function openNewProjectModal() {
    setShowNewProjectModal(true);
    setElasticsearchFormOpen(false);
    setDbFormOpen(false);
  }

  function closeNewProjectModal() {
    setShowNewProjectModal(false);
    setElasticsearchFormOpen(false);
    setDbFormOpen(false);
    setConnectionKindMenuOpen(false);
  }

  function openView(view: AppView) {
    setActiveView(view);
    setShowFlyoutChats(false);
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
      setActiveProject(config);
      setSidebarMode('project');
      setShowNewProjectModal(false);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setInspectorOpen(true);
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
      setActiveProject(config);
      setSidebarMode('project');
      setShowNewProjectModal(false);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setInspectorOpen(true);
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
    setConnectingProjectId(config.id);
    setBusy(true);
    updateStatus(`Connecting to ${config.label}...`);
    try {
      const nextSchema = await api.connect(config);
      setConnection(config);
      setActiveProject(config);
      setSidebarMode('project');
      setSchema(nextSchema);
      setActiveInspector('schema');
      setInspectorOpen(true);
      setActiveView('workspace');
      updateStatus(`Connected to ${config.label}`);
      await refreshHistories();
    } catch (error) {
      reportError('Could not connect to the saved database.', error);
    } finally {
      setBusy(false);
      setConnectingProjectId(null);
    }
  }

  async function openChatSession(session: PersistedChatSession) {
    if (!api) return;
    setActiveChatId(session.id);
    setMessages(session.messages.length ? session.messages : createInitialMessages());
    setPrompt('');
    setQuery(session.query ?? '');
    setResult(session.result ?? null);
    setChatActivity([]);
    setActivityOpen(false);
    setMessageActivities({});
    setMessageActivityOpen({});
    setActiveInspector(session.result ? 'results' : session.query ? 'query' : 'schema');
    setInspectorOpen(Boolean(session.result || session.query));
    setActiveView('workspace');
    setShowFlyoutChats(false);
    updateStatus(`Opened ${session.title}`);

    if (session.connection) {
      setActiveProject(session.connection);
      setSidebarMode('project');
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
    setResult(null);
    setChatActivity([]);
    setActivityOpen(false);
    setMessageActivities({});
    setMessageActivityOpen({});
    setActiveInspector('schema');
    setShowFlyoutChats(false);
    await refreshHistories();
    updateStatus('Chat history cleared');
  }

  async function deleteConnection(id: string) {
    if (!api) return;
    await api.deleteConnection(id);
    if (connection?.id === id) {
      closeProject();
    }
    await refreshHistories();
    updateStatus('Saved connection deleted');
  }

  function startRename(id: string, currentLabel: string) {
    setRenamingId(id);
    setRenameValue(currentLabel);
  }

  async function commitRename(id: string, label: string) {
    if (!api || !label.trim()) {
      setRenamingId(null);
      return;
    }
    await api.renameConnection(id, label.trim());
    setRenamingId(null);
    await refreshHistories();
    updateStatus('Connection renamed');
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
    setShowNewProjectModal(true);
    updateStatus(nextStatus);
  }

  function closeConnectionForm() {
    setElasticsearchFormOpen(false);
    setDbFormOpen(false);
  }

  function selectConnectionKind(kind: ConnectionLogoKind) {
    setConnectionKindMenuOpen(false);
    if (kind === 'sqlite') {
      setElasticsearchFormOpen(false);
      setDbFormOpen(false);
      void connectSqlite();
      return;
    }
    if (kind === 'elasticsearch') {
      setDbFormOpen(false);
      setElasticsearchHost('localhost');
      setElasticsearchPort('9200');
      setElasticsearchUseSsl(false);
      setElasticsearchVerifyCerts(true);
      setElasticsearchUsername('');
      setElasticsearchPassword('');
      setElasticsearchRememberPassword(false);
      setElasticsearchFormOpen(true);
      return;
    }
    setElasticsearchFormOpen(false);
    openDbForm(kind);
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
    setShowNewProjectModal(true);
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
      setActiveProject(config);
      setSidebarMode('project');
      setShowNewProjectModal(false);
      setSchema(nextSchema);
      setActiveInspector('schema');
      setInspectorOpen(true);
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
    const turnId = crypto.randomUUID();
    activeChatTurnIdRef.current = turnId;
    let streamedContent = '';
    let accumulatedThinking = '';
    const unsubscribeEvents = api.subscribeToAgentEvents(turnId, (event) => {
      if (event.turnId !== activeChatTurnIdRef.current) return;
      switch (event.type) {
        case 'text-delta':
          streamedContent += String(event.data.delta ?? '');
          setStreamingContent(streamedContent);
          break;
        case 'tool-start':
          setChatActivity((current) => [
            ...current,
            { id: String(event.data.toolName ?? ''), status: 'running', title: String(event.data.purpose ?? event.data.toolName ?? 'Running tool...'), createdAt: event.timestamp }
          ]);
          setActivityOpen(true);
          updateStatus(String(event.data.purpose ?? 'Running tool...'));
          break;
        case 'tool-complete':
          setChatActivity((current) =>
            current.map((step) =>
              step.id === event.data.toolName ? { ...step, status: 'success' as const } : step
            )
          );
          break;
        case 'thinking-delta':
          accumulatedThinking += String(event.data.delta ?? '');
          break;
        case 'status':
          updateStatus(String(event.data.message ?? ''));
          break;
        case 'approval-required':
          setPendingApproval({
            id: String(event.data.id),
            toolName: String(event.data.toolName),
            purpose: String(event.data.purpose),
            queryPreview: event.data.queryPreview as string | undefined,
            risk: (event.data.risk as string) as 'none' | 'low' | 'medium' | 'high'
          });
          break;
        case 'approval-resolved':
          setPendingApproval(null);
          break;
        case 'complete':
        case 'error':
        case 'aborted':
          break;
      }
    });
    setMessages((current) => [...current, userMessage]);
    setPrompt('');
    setChatActivity([]);
    setActivityOpen(false);
    setBusy(true);
    setAnswerGenerating(true);
    updateStatus('Thinking...');
    try {
      const chatHistory: ModelChatMessage[] = nextMessages.map((message) => ({
        role: message.role,
        content: message.content
      }));
      const response = await api.sendChat(chatHistory, turnId);
      const finalMessages = [...nextMessages, response.message];
      setMessages(finalMessages);
      setStreamingContent('');
      setChatActivity([]);
      setActivityOpen(false);
      setAnswerGenerating(false);
      setBusy(false);
      updateStatus('Response ready');
      await persistChatSession(finalMessages);
    } catch (error) {
      reportError('The chat request failed.', error);
    } finally {
      unsubscribeEvents();
      if (activeChatTurnIdRef.current === turnId) {
        activeChatTurnIdRef.current = null;
      }
      setAnswerGenerating(false);
      setBusy(false);
    }
  }

  async function approveInterruption() {
    if (!api || !pendingApproval) return;
    await api.approveInterruption(activeChatTurnIdRef.current!, pendingApproval.id);
    setPendingApproval(null);
  }

  async function denyInterruption() {
    if (!api || !pendingApproval) return;
    await api.denyInterruption(activeChatTurnIdRef.current!, pendingApproval.id);
    setPendingApproval(null);
  }

  async function runQuery() {
    if (!api || !query.trim()) return;
    setBusy(true);
    updateStatus('Running query...');
    try {
      const nextResult = await api.executeQuery(query);
      setResult(nextResult);
      setActiveInspector('results');
      setInspectorOpen(true);
      updateStatus(`Returned ${nextResult.rowCount} rows in ${nextResult.elapsedMs} ms`);
      await persistChatSession(messages, { query, result: nextResult });
    } catch (error) {
      reportError('The query could not be run.', error);
    } finally {
      setBusy(false);
    }
  }

  // Copy implementation
  async function copyResult() {
    if (!result) return;
    try {
      const tsv = serializeResultAsTsv(result);
      await navigator.clipboard.writeText(tsv);
      setCopiedFeedback(true);
      setTimeout(() => setCopiedFeedback(false), 1500);
      announce('Copied');
    } catch {
      announce('Copy failed');
    }
  }

  // Export CSV implementation
  async function exportCsv() {
    if (!result || !api) return;
    setExportingCsv(true);
    try {
      const csv = serializeResultAsCsv(result);
      const filename = activeChatTitle.replace(/[^a-zA-Z0-9-_\s]/g, '').replace(/\s+/g, '-').toLowerCase()
        + `-${new Date().toISOString().slice(0, 10)}.csv`;
      await api.saveCsvFile({ content: csv, defaultName: filename });
      announce('CSV exported');
    } catch (error) {
      announce('Export failed');
      appendLog('error', 'CSV export failed', logDetail(error));
    } finally {
      setExportingCsv(false);
    }
  }

  function announce(message: string) {
    const announcer = document.getElementById('aria-live-announcer');
    if (announcer) {
      announcer.textContent = message;
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
    const tempId = crypto.randomUUID();
    setActiveChatId(tempId);
    setMessages(createInitialMessages());
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

  function openOrFocusInspector(tab: InspectorTab) {
    setActiveInspector(tab);
    setInspectorOpen(true);
    announce('Inspector opened');
  }

  function closeInspector() {
    if (isProjectPage) return;
    setInspectorOpen(false);
  }

  // ----- Render Helpers -----

  function renderInspectorContent() {
    if (activeInspector === 'results') {
      return (
        <div className="inspector-body" aria-label="Data results">
          {result ? (
            <>
              <div className="result-metadata">
                <span>{result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.columns.length} {result.columns.length === 1 ? 'column' : 'columns'}</span>
                {result.elapsedMs > 0 && <span> · {result.elapsedMs} ms</span>}
              </div>
              <div className="result-table-wrap">
                <table className="result-table">
                  <thead>
                    <tr>
                      {result.columns.map((column) => {
                        const isNumeric = result.rows.some((row) => typeof row[column] === 'number');
                        return <th key={column} className={isNumeric ? 'numeric' : ''} scope="col">{column}</th>;
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, index) => (
                      <tr key={index}>
                        {result.columns.map((column) => {
                          const val = row[column];
                          const isNumeric = typeof val === 'number';
                          const isNull = val === null || val === undefined;
                          return (
                            <td key={column} className={`${isNumeric ? 'numeric' : ''} ${isNull ? 'null' : ''}`}>
                              {isNull ? '\u2014' : String(val)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="schema-empty">
              <Table2 size={20} />
              <span>Ask a data question to see rows here.</span>
            </div>
          )}
        </div>
      );
    }

    if (activeInspector === 'query') {
      return (
        <div className="inspector-body query-view" aria-label="Query editor">
          <textarea
            className="query-editor"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={connection?.kind === 'elasticsearch' || connection?.kind === 'mongodb' ? 'Generated JSON will appear here.' : 'Generated SQL will appear here.'}
            spellCheck={false}
          />
        </div>
      );
    }

    if (activeInspector === 'schema') {
      return (
        <div className="inspector-body schema-view" aria-label="Schema" onScroll={handleSchemaScroll} ref={schemaPanelRef}>
        {schema ? (
          <>
            <div className="schema-search-field">
              <Search size={14} />
              <input
                aria-label="Search schema"
                onChange={(event) => setSchemaSearch(event.target.value)}
                placeholder={`Search ${schemaObjectPlural(schema.kind)} or fields`}
                type="search"
                value={schemaSearch}
              />
            </div>
            <div className="schema-view-toggle">
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
              {!schemaSearchActive && filteredSchemaTables.length > 0 && (
                <button type="button" onClick={toggleAllSchemaItems} style={{ marginLeft: 'auto', fontSize: '11px', height: '26px', padding: '0 8px' }}>
                  {allSchemaItemsExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
            <div className="schema-list">
              {filteredSchemaTables.length ? (
                filteredSchemaTables.map((table) => {
                  const objectKind = schemaObjectKind(schema.kind);
                  const friendlyName = humanizeIdentifier(table.name);
                  const displayName = schemaViewMode === 'pro' ? friendlyName : table.name;
                  const expanded = schemaSearchActive || Boolean(expandedSchemaItems[table.name]);
                  return (
                    <div className="schema-item" key={table.name}>
                      <button
                        aria-expanded={expanded}
                        className={`schema-item-header ${expanded ? 'expanded' : ''}`}
                        onClick={() => toggleSchemaItem(table.name)}
                        type="button"
                      >
                        <ChevronRight size={14} />
                        <span className="schema-item-name">{displayName}</span>
                        <span className="schema-item-type">{objectKind}</span>
                        <span className="schema-item-count">{table.columns.length} {table.columns.length === 1 ? 'field' : 'fields'}</span>
                      </button>
                      {expanded && (
                        <div className="schema-item-fields">
                          {schemaViewMode === 'pro' ? (
                            <>
                              <div className="schema-prompt-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '4px 4px 8px 24px' }}>
                                {schemaStarterPrompts(friendlyName, objectKind).map((starterPrompt) => (
                                  <button type="button" onClick={() => chooseSchemaPrompt(starterPrompt)} key={starterPrompt} style={{ fontSize: '11px', height: 'auto', minHeight: '26px', padding: '4px 7px', justifyContent: 'flex-start' }}>
                                    {starterPrompt}
                                  </button>
                                ))}
                              </div>
                              {groupedSchemaFields(table.columns).map((group) => (
                                <div key={group.group}>
                                  <div style={{ color: 'var(--color-text-tertiary)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', padding: '6px 4px 2px 24px' }}>{group.group.toUpperCase()}</div>
                                  {group.fields.map((column) => (
                                    <div className="schema-field-row" key={column.name}>
                                      <span className="schema-field-name" style={{ fontWeight: 600 }}>{humanizeIdentifier(column.name)}</span>
                                      <span className="schema-field-type" style={{ fontSize: '10px' }}>{column.name}</span>
                                      <span className="schema-field-type">{column.type}</span>
                                      {column.primaryKey && <span className="schema-field-type" style={{ color: 'var(--color-accent)' }}>Primary</span>}
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </>
                          ) : (
                            table.columns.map((column) => (
                              <div className="schema-field-row" key={column.name}>
                                <span className="schema-field-name" style={{ fontWeight: 600 }}>{column.name}</span>
                                <span className="schema-field-type">{fieldGroup(column)}</span>
                                <span className="schema-field-type">{column.type}</span>
                                {column.primaryKey && <span className="schema-field-type" style={{ color: 'var(--color-accent)' }}>Primary</span>}
                                <span className="schema-field-type">{column.nullable ? 'Nullable' : 'Required'}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="schema-empty">
                  <Search size={20} />
                  <span>No schema matches found.</span>
                </div>
              )}
            </div>
            {schemaScrolled && (
              <button
                aria-label="Return to top of schema"
                onClick={scrollSchemaToTop}
                type="button"
                style={{ position: 'sticky', bottom: 8, alignSelf: 'flex-end', zIndex: 10, fontSize: '11px', height: '28px', gap: '5px' }}
              >
                <ArrowUp size={14} />
                Top
              </button>
            )}
          </>
        ) : (
          <div className="schema-empty">
            <Database size={20} />
            <span>Connect a database to inspect its schema.</span>
          </div>
        )}
      </div>
      );
    }

    if (activeInspector === 'audit') {
      const entries = auditEntries;
      return (
        <div className="inspector-body" aria-label="Audit log" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '16px 28px' }}>
          {entries.length === 0 ? (
            <div className="schema-empty">
              <span>No audit entries yet. Tool calls will be logged here.</span>
            </div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} style={{
                borderBottom: '1px solid var(--color-separator)',
                padding: '10px 0',
                display: 'grid',
                gap: '4px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{entry.toolName}</span>
                  <time style={{ color: 'var(--color-text-tertiary)', fontSize: '11px' }}>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                {entry.queryPreview && (
                  <code style={{ fontSize: '11px', background: 'var(--code-bg)', color: 'var(--code-text)', padding: '4px 8px', borderRadius: 'var(--radius-row)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{entry.queryPreview}</code>
                )}
                <span style={{
                  fontSize: '11px',
                  color: entry.permissionDecision === 'allow' ? 'var(--color-success)' : entry.permissionDecision === 'denied' ? 'var(--color-danger)' : 'var(--color-warning)'
                }}>
                  {entry.permissionDecision}
                  {entry.risk ? ` · ${entry.risk}` : ''}
                </span>
              </div>
            ))
          )}
        </div>
      );
    }
  }

  function renderInspector() {
    const inspectorFooter = (
      <div className="inspector-footer">
        {activeInspector === 'results' ? (
          <>
            <button
              className="inspector-footer-action"
              disabled={!result}
              onClick={() => void copyResult()}
              type="button"
              aria-label={copiedFeedback ? 'Copied' : 'Copy'}
            >
              <Copy size={14} />
              {copiedFeedback ? 'Copied' : 'Copy'}
            </button>
            <button
              className="inspector-footer-action"
              disabled={!result || exportingCsv}
              onClick={() => void exportCsv()}
              type="button"
              aria-label={exportingCsv ? 'Exporting…' : 'Export CSV'}
            >
              <Download size={14} />
              {exportingCsv ? 'Exporting\u2026' : 'Export CSV'}
            </button>
          </>
        ) : activeInspector === 'query' ? (
          <>
            <button
              className="inspector-footer-action"
              disabled={!query.trim()}
              onClick={() => void navigator.clipboard.writeText(query)}
              type="button"
            >
              <Copy size={14} />
              Copy Query
            </button>
            <button
              className="inspector-footer-action"
              disabled={busy || !query.trim()}
              onClick={() => void runQuery()}
              type="button"
            >
              <Play size={14} />
              Run Query
            </button>
          </>
        ) : null}
      </div>
    );

    const inspectorClass = isConstrained && inspectorOpen ? 'inspector-overlay' : 'inspector';

    return (
      <aside className={inspectorClass} id="inspector-sidebar" aria-label="Inspector">
        <div className="inspector-header">
          <div className="inspector-header-top">
            <h2 className="inspector-title">
              {activeInspector === 'results' ? 'Data' : activeInspector === 'query' ? 'Query' : activeInspector === 'audit' ? 'Audit' : 'Schema'}
            </h2>
          </div>
          {connection && (
            <div className="inspector-source">
              <Database size={14} />
              <span>{connection.label}</span>
            </div>
          )}
        </div>
        <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
          <button
            className={`inspector-tab ${activeInspector === 'results' ? 'selected' : ''}`}
            onClick={() => setActiveInspector('results')}
            role="tab"
            aria-selected={activeInspector === 'results'}
            aria-controls="inspector-results-panel"
            type="button"
          >
            Results
          </button>
          <button
            className={`inspector-tab ${activeInspector === 'query' ? 'selected' : ''}`}
            onClick={() => setActiveInspector('query')}
            role="tab"
            aria-selected={activeInspector === 'query'}
            aria-controls="inspector-query-panel"
            type="button"
          >
            Query
          </button>
          <button
            className={`inspector-tab ${activeInspector === 'schema' ? 'selected' : ''}`}
            onClick={() => setActiveInspector('schema')}
            role="tab"
            aria-selected={activeInspector === 'schema'}
            aria-controls="inspector-schema-panel"
            type="button"
          >
            Schema
          </button>
          <button
            className={`inspector-tab ${activeInspector === 'audit' ? 'selected' : ''}`}
            onClick={() => {
              setActiveInspector('audit');
              if (api) void api.getAuditLog().then(setAuditEntries);
            }}
            role="tab"
            aria-selected={activeInspector === 'audit'}
            aria-controls="inspector-audit-panel"
            type="button"
          >
            Audit
          </button>
        </div>
        <div
          id={`inspector-${activeInspector}-panel`}
          role="tabpanel"
          style={{ display: 'contents' }}
        >
          {renderInspectorContent()}
        </div>
        {inspectorFooter}
      </aside>
    );
  }

  function renderElasticsearchForm() {
    if (!elasticsearchFormOpen) {
      return null;
    }

    return (
      <form className="connection-form" aria-label="Elasticsearch connection" onSubmit={(event) => void connectElasticsearch(event)}>
        <div className="connection-form-row">
          <label htmlFor="es-host">Host</label>
          <input id="es-host" value={elasticsearchHost} onChange={(event) => setElasticsearchHost(event.target.value)} placeholder="localhost" />
        </div>
        <div className="connection-form-row">
          <label htmlFor="es-port">Port</label>
          <input id="es-port" value={elasticsearchPort} onChange={(event) => setElasticsearchPort(event.target.value)} inputMode="numeric" type="number" min={1} max={65535} />
        </div>
        <div className="connection-form-row">
          <label htmlFor="es-user">Username</label>
          <input id="es-user" value={elasticsearchUsername} onChange={(event) => setElasticsearchUsername(event.target.value)} />
        </div>
        <div className="connection-form-row">
          <label htmlFor="es-pass">Password</label>
          <input id="es-pass" type="password" value={elasticsearchPassword} onChange={(event) => setElasticsearchPassword(event.target.value)} />
        </div>
        <div className="connection-form-checkbox">
          <input id="es-ssl" type="checkbox" checked={elasticsearchUseSsl} onChange={(event) => setElasticsearchUseSsl(event.target.checked)} />
          <label htmlFor="es-ssl">Use HTTPS</label>
        </div>
        <div className="connection-form-checkbox">
          <input id="es-certs" type="checkbox" checked={elasticsearchVerifyCerts} onChange={(event) => setElasticsearchVerifyCerts(event.target.checked)} disabled={!elasticsearchUseSsl} />
          <label htmlFor="es-certs">Verify TLS certificates</label>
        </div>
        <div className="connection-form-checkbox">
          <input id="es-remember" type="checkbox" checked={elasticsearchRememberPassword} onChange={(event) => setElasticsearchRememberPassword(event.target.checked)} />
          <label htmlFor="es-remember">Remember password</label>
        </div>
        <div className="connection-form-actions">
          <button type="submit" className="primary-button connection-form-submit" disabled={busy || !elasticsearchHost.trim() || !elasticsearchPort.trim()}>
            Connect
          </button>
          <button type="button" className="connection-form-cancel" onClick={closeConnectionForm}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderDbForm() {
    if (!dbFormOpen) {
      return null;
    }

    const label = dbKindLabel(dbFormKind);

    return (
      <form className="connection-form" aria-label={`${label} connection`} onSubmit={(event) => void connectDb(event)}>
        <div className="connection-form-row">
          <label htmlFor="db-host">Host</label>
          <input id="db-host" value={dbFormHost} onChange={(event) => setDbFormHost(event.target.value)} placeholder="localhost" />
        </div>
        <div className="connection-form-row">
          <label htmlFor="db-port">Port</label>
          <input id="db-port" value={dbFormPort} onChange={(event) => setDbFormPort(event.target.value)} inputMode="numeric" type="number" min={1} max={65535} />
        </div>
        <div className="connection-form-row">
          <label htmlFor="db-name">Database</label>
          <input id="db-name" value={dbFormDatabase} onChange={(event) => setDbFormDatabase(event.target.value)} placeholder="mydb" />
        </div>
        <div className="connection-form-row">
          <label htmlFor="db-user">Username</label>
          <input id="db-user" value={dbFormUsername} onChange={(event) => setDbFormUsername(event.target.value)} />
        </div>
        <div className="connection-form-row">
          <label htmlFor="db-pass">Password</label>
          <input id="db-pass" type="password" value={dbFormPassword} onChange={(event) => setDbFormPassword(event.target.value)} />
        </div>
        {dbFormKind === 'mongodb' && (
          <div className="connection-form-row">
            <label htmlFor="db-auth">Auth database</label>
            <input id="db-auth" value={dbFormAuthDatabase} onChange={(event) => setDbFormAuthDatabase(event.target.value)} placeholder="admin" />
          </div>
        )}
        <div className="connection-form-checkbox">
          <input id="db-ssl" type="checkbox" checked={dbFormSsl} onChange={(event) => setDbFormSsl(event.target.checked)} />
          <label htmlFor="db-ssl">Use SSL/TLS</label>
        </div>
        <div className="connection-form-checkbox">
          <input id="db-remember" type="checkbox" checked={dbFormRememberPassword} onChange={(event) => setDbFormRememberPassword(event.target.checked)} />
          <label htmlFor="db-remember">Remember password</label>
        </div>
        <div className="connection-form-actions">
          <button type="submit" className="primary-button connection-form-submit" disabled={busy || !dbFormHost.trim() || !dbFormPort.trim()}>
            Connect
          </button>
          <button type="button" className="connection-form-cancel" onClick={closeConnectionForm}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderSettingsControls() {
    return (
      <>
        <div className="settings-section">
          <p className="settings-section-title">Model provider</p>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor="provider-select">Provider</label>
            <div className="settings-row-control">
              <select id="provider-select" value={settings.provider} onChange={(event) => void changeProvider(event.target.value as ModelProviderKind)} aria-label="Model provider">
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
              </select>
            </div>
          </div>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor="model-input">Model</label>
            <div className="settings-row-control">
              <div className="model-select-wrap">
                <input id="model-input" value={modelSearch} onChange={(event) => void changeModelSearch(event.target.value)} list="model-options" disabled={modelsLoading || !models.length} aria-label="Model name" placeholder={modelsLoading ? 'Loading models...' : 'Search models'} />
                <datalist id="model-options">
                  {filteredModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  ))}
                </datalist>
                {modelsLoading && <Loader2 className="spin" size={16} aria-label="Loading models" />}
              </div>
            </div>
          </div>
        </div>
        <div className="settings-section">
          <p className="settings-section-title">API key</p>
          <div className="settings-row">
            <label className="settings-row-label" htmlFor="api-key-input">{settings.provider} API key</label>
            <div className="settings-row-control">
              <div className="api-key-row">
                <input id="api-key-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? 'API key saved' : 'Paste API key'} aria-label="API key" />
                <button type="button" className="primary-button" onClick={() => void saveApiKey()} disabled={!apiKey.trim()}>Save</button>
              </div>
            </div>
          </div>
          <p className="settings-help">Keys are stored locally and never sent to the server.</p>
          <div className={`settings-status ${settings.hasApiKey ? 'saved' : ''}`}>
            {settings.hasApiKey && <CheckCircle2 size={15} />}
            {settingsStatus || (settings.hasApiKey ? 'API key saved.' : 'No API key saved.')}
          </div>
        </div>
      </>
    );
  }

  function renderChatHistory(limit?: number) {
    const sessions = typeof limit === 'number' ? chatSessions.slice(0, limit) : chatSessions;
    return (
      <div className="history-list">
        {sessions.length ? sessions.map((session) => (
          <div className={`history-item ${activeChatId === session.id ? 'active' : ''}`} key={session.id}>
            <button type="button" className="history-main" onClick={() => void openChatSession(session)}>
              <MessageSquareText size={15} />
              <span className="history-main-info">
                <strong>{session.title}</strong>
                <small>{formatHistoryDate(session.updatedAt)}</small>
              </span>
            </button>
            <button type="button" className="history-delete" onClick={() => void deleteChatSession(session.id)} aria-label={`Delete chat ${session.title}`}>
              <Trash2 size={14} />
            </button>
          </div>
        )) : (
          <p className="history-empty">Saved chats will appear here.</p>
        )}
      </div>
    );
  }

  function renderFocusedView() {
    if (activeView === 'workspace') {
      if (!activeProject) {
        if (savedConnections.length > 0) {
          return (
          <section className="focus-view" aria-label="Projects">
            <header className="focus-header">
              <div className="focus-header-title">
                <p>Select a project</p>
                <h2>Projects</h2>
              </div>
            </header>
            <div className="project-grid">
              {savedConnections.length ? savedConnections.map((conn) => {
                const isConnecting = connectingProjectId === conn.id;
                return (
                  <button
                    key={conn.id}
                    className={`project-card ${isConnecting ? 'connecting' : ''}`}
                    onClick={() => void connectFromHistory(conn)}
                    disabled={busy}
                    type="button"
                  >
                    {isConnecting && (
                      <div className="project-card-loader">
                        <Loader2 className="spin" size={22} />
                      </div>
                    )}
                    <div className="project-card-icon">
                      <ConnectionLogo kind={conn.kind} />
                    </div>
                    <span className="project-card-name">{conn.label}</span>
                    <span
                      className="project-card-kind"
                      style={{
                        color: conn.kind === 'sqlite' ? 'var(--source-neutral)' : conn.kind === 'postgres' ? 'var(--source-analytics)' : conn.kind === 'mysql' ? 'var(--source-customer)' : conn.kind === 'mongodb' ? 'var(--source-operations)' : 'var(--source-marketing)'
                      }}
                    >
                      <span
                        className="sidebar-source-dot"
                        style={{
                          backgroundColor: 'currentColor',
                          width: '6px',
                          height: '6px',
                          borderRadius: 'var(--radius-round)',
                          flexShrink: 0
                        }}
                      />
                      {dbKindDisplayName(conn.kind)}
                    </span>
                  </button>
                );
              }) : (
                <p className="history-empty">No saved projects yet.</p>
              )}
              <button
                type="button"
                className="project-card project-card-add"
                onClick={openNewProjectModal}
              >
                <div className="project-card-icon">
                  <Plus size={28} />
                </div>
                <span className="project-card-name">New project</span>
                <span className="project-card-kind">Connect a database</span>
              </button>
            </div>
          </section>
        );
      }
      return null;
    }

    if (activeView === 'workspace' && !activeChatId) {
        return (
          <section className="focus-view" aria-label="Project home">
            <header className="focus-header">
              <div className="focus-header-title">
                <p>{activeProject ? dbKindDisplayName(activeProject.kind) : ''} project</p>
                <h2>{activeProject?.label ?? ''}</h2>
              </div>
              <button type="button" className="primary-button" onClick={resetChat}>
                <Plus size={16} />
                New chat
              </button>
            </header>
            <div className="connections-section">
              <p className="connections-section-title">Database status</p>
              <div className="connection-status-row">
                <span className="status-dot connected" />
                <span className="connection-status-label">Connected</span>
                <span className="connection-status-detail">{schemaSummary}</span>
              </div>
            </div>
            {schema && (
              <div className="connections-section">
                <p className="connections-section-title">Quick prompts</p>
                <div className="starter-list">
                  {starterPrompts.map((starter) => (
                    <button type="button" className="starter-row" onClick={() => chooseStarter(starter.prompt)} key={starter.title}>
                      <span className="sidebar-action-row-label">{starter.title}</span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="connections-section">
              <p className="connections-section-title">Recent chats</p>
              {chatSessions.filter((session) => session.connection?.id === (activeProject ? activeProject.id : '')).length ? (
                <div className="history-list">
                  {chatSessions
                    .filter((session) => session.connection?.id === (activeProject ? activeProject.id : ''))
                    .slice(0, 6)
                    .map((session) => (
                      <div className={`history-item ${activeChatId === session.id ? 'active' : ''}`} key={session.id}>
                        <button type="button" className="history-main" onClick={() => void openChatSession(session)}>
                          <MessageSquareText size={15} />
                          <span className="history-main-info">
                            <strong>{session.title}</strong>
                            <small>{formatHistoryDate(session.updatedAt)}</small>
                          </span>
                        </button>
                        <button type="button" className="history-delete" onClick={() => void deleteChatSession(session.id)} aria-label={`Delete chat ${session.title}`}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="history-empty">New chats in this project will appear here.</p>
              )}
            </div>
          </section>
        );
      }
      return null;
    }

    if (activeView === 'history') {
      const projectSessions = activeProject
        ? chatSessions.filter((session) => session.connection?.id === activeProject.id)
        : chatSessions;
      return (
        <section className="focus-view" aria-label="Chat history">
          <header className="focus-header">
            <div className="focus-header-title">
              <p>Saved conversations</p>
              <h2>History</h2>
            </div>
            <div className="focus-header-actions">
              <button type="button" onClick={() => void clearChatHistory()} disabled={!chatSessions.length || !api}>
                <Trash2 size={16} />
                Clear all
              </button>
              <button type="button" className="primary-button" onClick={resetChat}>
                <Plus size={16} />
                New chat
              </button>
            </div>
          </header>
          <div className="history-list">
            {projectSessions.length ? projectSessions.map((session) => (
              <div className={`history-item ${activeChatId === session.id ? 'active' : ''}`} key={session.id}>
                <button type="button" className="history-main" onClick={() => void openChatSession(session)}>
                  <MessageSquareText size={15} />
                  <span className="history-main-info">
                    <strong>{session.title}</strong>
                    <small>{formatHistoryDate(session.updatedAt)}</small>
                  </span>
                </button>
                <button type="button" className="history-delete" onClick={() => void deleteChatSession(session.id)} aria-label={`Delete chat ${session.title}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            )) : (
              <p className="history-empty">Saved chats will appear here.</p>
            )}
          </div>
        </section>
      );
    }

    return renderSettingsView();
  }

  function renderSettingsView() {
    return (
      <section className="focus-view" aria-label="Settings">
        <header className="focus-header">
          <div className="focus-header-title">
            <p>Model and safety</p>
            <h2>Settings</h2>
          </div>
          <button type="button" className="focus-back-button" onClick={() => openView('workspace')}>Back to chat</button>
        </header>

        {renderSettingsControls()}

        <div className="settings-section">
          <p className="settings-section-title">Connections</p>
          {savedConnections.length ? (
            <div className="history-list">
              {savedConnections.map((item) => (
                <div className={`saved-connection-row ${connection?.id === item.id ? 'active' : ''}`} key={item.id}>
                  {renamingId === item.id ? (
                    <div className="saved-connection-rename">
                      <input
                        className="rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(item.id, renameValue);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        autoFocus
                        ref={(el) => {
                          if (el && el.value === item.label) el.select();
                        }}
                      />
                      <button
                        type="button"
                        className="saved-connection-rename-action save"
                        onClick={() => void commitRename(item.id, renameValue)}
                        aria-label="Save rename"
                        title="Save"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="saved-connection-rename-action cancel"
                        onClick={() => setRenamingId(null)}
                        aria-label="Cancel rename"
                        title="Cancel"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="saved-connection-main"
                      onClick={() => void connectFromHistory(item)}
                      disabled={busy}
                      aria-current={connection?.id === item.id ? 'true' : undefined}
                    >
                      <ConnectionLogo kind={item.kind} monochrome />
                      <span className="saved-connection-label">{item.label}</span>
                      <span className="saved-connection-date">{dbKindDisplayName(item.kind)}</span>
                    </button>
                  )}
                  {renamingId !== item.id && (
                    <button
                      type="button"
                      className="saved-connection-edit"
                      onClick={() => startRename(item.id, item.label)}
                      aria-label={`Rename connection ${item.label}`}
                      title="Rename"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="saved-connection-delete"
                    onClick={() => void deleteConnection(item.id)}
                    aria-label={`Delete connection ${item.label}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="primary-button"
                onClick={openNewProjectModal}
                style={{ marginTop: '12px' }}
              >
                <Plus size={16} />
                Add connection
              </button>
            </div>
          ) : (
            <div className="history-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
              <p>No saved connections yet.</p>
              <button type="button" className="primary-button" onClick={openNewProjectModal}>
                <Plus size={16} />
                Add connection
              </button>
            </div>
          )}
        </div>

        <div className="settings-section">
          <p className="settings-section-title">Appearance</p>
          {(['light', 'dark'] as const).map((group) => {
            const groupThemes = themeRegistry.filter((entry) => entry.group === group);
            const selectedId = groupThemes.some((entry) => entry.id === theme)
              ? theme
              : groupThemes[0]?.id ?? theme;
            return (
              <div className="theme-row" key={group}>
                <div className="theme-row-label">
                  {group === 'light' ? <Sun size={14} /> : <Moon size={14} />}
                  {group === 'light' ? 'Light' : 'Dark'}
                </div>
                <select className="theme-select" value={selectedId} onChange={(event) => setTheme(event.target.value as ThemeMode)} aria-label={`${group === 'light' ? 'Light' : 'Dark'} theme`}>
                  {groupThemes.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div className="settings-section">
          <p className="settings-section-title">Provider status</p>
          <div className="provider-summary">
            <strong>{settings.provider}</strong>
            <span>{settings.model}</span>
            <span>{settings.hasApiKey ? 'API key saved locally' : 'API key not saved'}</span>
          </div>
        </div>

        <div className="settings-section">
          <p className="settings-section-title">Application logs</p>
          <button type="button" className="logs-toggle" onClick={() => setLogsOpen((current) => !current)} aria-expanded={logsOpen}>
            {logsOpen ? 'Hide logs' : 'View logs'}
          </button>
          {logsOpen && (
            <div className="logs-section">
              <div className="logs-list">
                {logs.length ? logs.map((entry) => (
                  <article className={`log-entry ${entry.level}`} key={entry.id}>
                    <div className="log-entry-header">
                      <strong>{entry.message}</strong>
                      <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    </div>
                    {entry.detail && <pre>{entry.detail}</pre>}
                  </article>
                )) : (
                  <p className="log-entry-empty">App activity and error details will appear here.</p>
                )}
              </div>
              {logs.length > 0 && (
                <button type="button" className="focus-back-button" onClick={() => setLogs([])} style={{ marginTop: '12px' }}>Clear logs</button>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  const shellStyle = {
    '--sidebar-width': `${inspectorOpen ? (isConstrained ? '220px' : '240px') : (isConstrained ? '220px' : '240px')}`,
    '--inspector-width': inspectorOpen ? `${isConstrained ? '0px' : `${rightPanelWidth}px`}` : '0px'
  } as CSSProperties;

  return (
    <main
      className={`app-shell${resizeDrag ? ' resizing-panels' : ''}`}
      ref={shellRef}
      style={shellStyle}
    >
      {/* ARIA live region for announcements */}
      <div id="aria-live-announcer" aria-live="polite" aria-atomic="true" className="visually-hidden" />

      {/* Workspace Sidebar */}
      <aside className="workspace-sidebar" aria-label="Database workspace">
        <div className="sidebar-content">
          {sidebarMode === 'projects' ? (
            <>
              <div className="sidebar-section-label" style={{ marginTop: 0 }}>Projects</div>
              {savedConnections.length > 0 ? savedConnections.map((conn) => (
                <button
                  className={`sidebar-action-row ${connection?.id === conn.id ? 'selected' : ''}`}
                  key={conn.id}
                  onClick={() => void connectFromHistory(conn)}
                  type="button"
                >
                  <span
                    className="sidebar-source-dot"
                    style={{ backgroundColor: conn.kind === 'sqlite' ? 'var(--source-neutral)' : conn.kind === 'postgres' ? 'var(--source-analytics)' : conn.kind === 'mysql' ? 'var(--source-customer)' : conn.kind === 'mongodb' ? 'var(--source-operations)' : 'var(--source-marketing)' }}
                  />
                  <span className="sidebar-action-row-label">{conn.label}</span>
                </button>
              )) : (
                <p className="sidebar-empty">No projects yet.</p>
              )}
              <button
                className="sidebar-action-row"
                onClick={openNewProjectModal}
                type="button"
              >
                <Plus size={16} />
                <span className="sidebar-action-row-label">Add project</span>
              </button>
            </>
          ) : activeProject ? (
            <>
              <button
                className="sidebar-action-row"
                onClick={closeProject}
                type="button"
              >
                <ArrowLeft size={16} />
                <span className="sidebar-action-row-label">All projects</span>
              </button>
              <div className="sidebar-section-label">{activeProject.label}</div>
              <button
                aria-label="New chat"
                className="sidebar-action-row"
                onClick={resetChat}
                type="button"
              >
                <Plus size={16} />
                <span className="sidebar-action-row-label">New chat</span>
              </button>
              <div className="sidebar-section-label">Chats</div>
              {chatSessions
                .filter((session) => session.connection?.id === activeProject.id)
                .slice(0, 6)
                .map((session) => (
                  <button
                    className={`sidebar-action-row ${activeChatId === session.id ? 'selected' : ''}`}
                    key={session.id}
                    onClick={() => void openChatSession(session)}
                    type="button"
                  >
                    <MessageSquareText size={16} />
                    <span className="sidebar-action-row-label">{session.title}</span>
                  </button>
                ))}
              {chatSessions.filter((session) => session.connection?.id === activeProject.id).length > 6 && (
                <button
                  className="sidebar-action-row"
                  onClick={() => openView('history')}
                  type="button"
                >
                  <span className="sidebar-action-row-label" style={{ color: 'var(--color-text-tertiary)', fontSize: '12px' }}>Show more</span>
                  <ChevronDown size={14} />
                </button>
              )}
            </>
          ) : null}
        </div>
        <div className="sidebar-spacer" />
        <button
          aria-label="Settings"
          className={`sidebar-action-row ${activeView === 'settings' ? 'selected' : ''}`}
          onClick={() => openView('settings')}
          type="button"
        >
          <Settings size={16} />
          <span className="sidebar-action-row-label">Settings</span>
        </button>
      </aside>

      {/* Conversation Canvas */}
      <section className="conversation-pane" aria-label={activeView === 'workspace' ? 'Chat' : 'Workspace view'}>
        {renderFocusedView() ?? (
          <>
            <div className="conversation-header">
              <div className="conversation-header-main">
                <h1 className="conversation-title">{activeChatTitle}</h1>
                <p className="conversation-date-label">Today</p>
                <div className="conversation-status">
                  <span>{status}</span>
                </div>
              </div>
              {!isProjectPage && (
              <button
                aria-label={inspectorOpen ? 'Hide inspector panel' : 'Show inspector panel'}
                className="inspector-toggle"
                onClick={() => { if (inspectorOpen) closeInspector(); else { setActiveInspector('schema'); setInspectorOpen(true); } }}
                title={inspectorOpen ? 'Hide inspector panel' : 'Show inspector panel'}
                type="button"
              >
                {inspectorOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              </button>
            )}
              <hr className="conversation-divider" />
            </div>

            <div className="transcript" ref={messagesRef}>
              {hasOnlyWelcomeMessage && (
                <section className="welcome-panel" aria-label="Starter prompts">
                  <div>
                    <h3>Ask about the data.</h3>
                    <p>
                      Connect a database and DB Chat will analyze your data through the conversation.
                    </p>
                  </div>
                  <div className="starter-list">
                    {starterPrompts.map((starter) => (
                      <button type="button" className="starter-row" onClick={() => chooseStarter(starter.prompt)} key={starter.title}>
                        <span className="sidebar-action-row-label">{starter.title}</span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {messages.length > 1 && (
                <div className="transcript-grid">
                  {messages.map((message) => {
                    const completedActivity = message.role === 'assistant' ? messageActivities[message.id] : undefined;
                    const shouldShowCompletedActivity = Boolean(completedActivity?.length);
                    return (
                      <div className="transcript-row" key={message.id}>
                        <div className="transcript-actor">
                          {message.role === 'assistant' ? 'DB Chat' : 'You'}
                        </div>
                        <div className="transcript-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                          {message.role === 'assistant' && result && (
                            <button
                              className="result-link"
                              onClick={() => openOrFocusInspector('results')}
                              type="button"
                            >
                              View {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'}
                            </button>
                          )}
                          {shouldShowCompletedActivity && (
                            <div className="inline-activity">
                              <button
                                type="button"
                                onClick={() => setMessageActivityOpen((current) => ({
                                  ...current,
                                  [message.id]: !(current[message.id] ?? false)
                                }))}
                                style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '4px 0', height: 'auto' }}
                                aria-expanded={messageActivityOpen[message.id] ?? false}
                              >
                                <ChevronDown size={14} style={{ transition: 'transform 120ms', transform: messageActivityOpen[message.id] ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                                <span>{activitySummary(completedActivity ?? [], false)}</span>
                              </button>
                              {(messageActivityOpen[message.id] ?? false) && (
                                <div className="inline-activity-steps">
                                  {completedActivity?.map((step) => (
                                    <div className="inline-activity-step" key={step.id}>
                                      <span className="activity-step-icon">{activityIcon(step)}</span>
                                      <span>{step.title}</span>
                                      {step.status && <span style={{ color: 'var(--color-text-tertiary)', fontSize: '11px' }}>{step.status}</span>}
                                      {step.rowCount !== undefined && <span style={{ color: 'var(--color-text-tertiary)', fontSize: '11px' }}>{step.rowCount} rows</span>}
                                      {step.elapsedMs !== undefined && <span style={{ color: 'var(--color-text-tertiary)', fontSize: '11px' }}>{step.elapsedMs} ms</span>}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="transcript-time">{formatTimestamp(message.createdAt)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div ref={messagesEndRef} />

              {/* Live activity */}
              {answerGenerating && chatActivity.length > 0 && (
                <div className="inline-activity" style={{ paddingTop: '12px' }}>
                  <div className="inline-activity-row">
                    <Loader2 className="inline-activity-spinner" size={14} />
                    <span className="inline-activity-text">{activitySummary(chatActivity, true)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActivityOpen((current) => !current)}
                    style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 0', height: 'auto', marginLeft: '20px' }}
                    aria-expanded={activityOpen}
                  >
                    <ChevronDown size={14} style={{ transition: 'transform 120ms', transform: activityOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                    <span>Details</span>
                  </button>
                  {activityOpen && (
                    <div className="inline-activity-steps">
                      {chatActivity.map((step) => (
                        <div className="inline-activity-step" key={step.id}>
                          <span className="activity-step-icon">{activityIcon(step)}</span>
                          <span>{step.title}</span>
                          {step.status && <span style={{ color: 'var(--color-text-tertiary)', fontSize: '11px' }}>{step.status}</span>}
                          {step.query && <code style={{ fontSize: '11px', background: 'var(--color-control)', padding: '1px 4px', borderRadius: '4px' }}>{step.query}</code>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Composer */}
            <div className="composer-wrapper">
              <form className="composer" onSubmit={(event) => void sendChat(event)}>
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      const form = event.currentTarget.closest('form');
                      if (form) form.requestSubmit();
                    }
                  }}
                  placeholder="Ask a follow-up"
                  aria-label="Message input"
                />
                <button
                  type="submit"
                  className="composer-send"
                  disabled={busy || !prompt.trim()}
                  aria-label="Send message"
                  title="Send message"
                >
                  {answerGenerating ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                </button>
                <div className="composer-footer" ref={dropdownRef}>
                  <div className="composer-footer-group">
                    <label className="composer-footer-label">Reasoning</label>
                    <div className="composer-select">
                      <button
                        type="button"
                        className="composer-select-trigger"
                        onClick={() => setOpenDropdown(openDropdown === 'reasoning' ? null : 'reasoning')}
                        aria-expanded={openDropdown === 'reasoning'}
                        aria-label="Reasoning effort"
                      >
                        <span>{effortLevel === 'none' ? 'Fast' : effortLevel.charAt(0).toUpperCase() + effortLevel.slice(1)}</span>
                        <ChevronDown size={12} className="chevron" />
                      </button>
                      {openDropdown === 'reasoning' && (
                        <div className="composer-select-menu" role="menu">
                          {(['none', 'low', 'medium', 'high', 'max'] as EffortLevel[]).map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="menuitem"
                              className={`composer-select-item ${effortLevel === level ? 'active' : ''}`}
                              onClick={() => {
                                setEffortLevel(level);
                                setSettings((current) => ({ ...current, effortLevel: level }));
                                void api?.saveSettings({ ...settings, effortLevel: level });
                                setOpenDropdown(null);
                              }}
                            >
                              {level === 'none' ? 'Fast' : level.charAt(0).toUpperCase() + level.slice(1)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {connection && (
                    <div className="composer-footer-group">
                      <label className="composer-footer-label">Safety</label>
                      <div className="composer-select composer-select--safety" data-level={safetyLevel}>
                        <button
                          type="button"
                          className="composer-select-trigger"
                          onClick={() => setOpenDropdown(openDropdown === 'safety' ? null : 'safety')}
                          aria-expanded={openDropdown === 'safety'}
                          aria-label="Safety level"
                        >
                          <ShieldCheck size={13} aria-hidden="true" />
                          <span>{safetyLevel === 'safe' ? 'Safe' : safetyLevel === 'unrestricted' ? 'Unrestricted' : 'Standard'}</span>
                          <ChevronDown size={12} className="chevron" />
                        </button>
                        {openDropdown === 'safety' && (
                          <div className="composer-select-menu" role="menu">
                            {(['safe', 'standard', 'unrestricted'] as SafetyLevel[]).map((level) => (
                              <button
                                key={level}
                                type="button"
                                role="menuitem"
                                className={`composer-select-item ${safetyLevel === level ? 'active' : ''}`}
                                onClick={async () => {
                                  setSafetyLevelState(level);
                                  if (api && connection) {
                                    await api.setSafetyLevel(connection.id, level);
                                    await refreshHistories();
                                  }
                                  setOpenDropdown(null);
                                }}
                              >
                                {level === 'safe' ? 'Safe' : level === 'unrestricted' ? 'Unrestricted' : 'Standard'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="composer-footer-spacer" aria-hidden="true" />
                </div>
              </form>
            </div>
          </>
        )}
      </section>

      {/* Inspector */}
      {inspectorOpen || isProjectPage ? (
        renderInspector()
      ) : (
        <aside className="panel-rail inspector-rail" id="inspector-sidebar" aria-label="Collapsed inspector sidebar" style={{ gridColumn: 3, borderLeft: '1px solid var(--color-separator)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 9px' }}>
          <button
            aria-label="Expand inspector sidebar"
            className="toolbar-icon-button"
            onClick={() => { setInspectorOpen(true); }}
            title="Expand inspector sidebar"
            type="button"
          >
            <PanelRightOpen size={18} />
          </button>
        </aside>
      )}

      {/* Resize handle */}
      {inspectorOpen && !isConstrained && (
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
      )}      {/* New Project Modal */}
      {showNewProjectModal && (
        <div className="project-modal-backdrop" onClick={closeNewProjectModal}>
          <div className="project-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New connection">
            <div className="project-modal-header">
              <h2>New connection</h2>
              <button
                type="button"
                className="toolbar-icon-button"
                onClick={closeNewProjectModal}
                aria-label="Close"
              >
                <XCircle size={18} />
              </button>
            </div>
            <div className="project-modal-body">
              <p className="connections-section-title">Select connection type</p>
              {!(elasticsearchFormOpen || dbFormOpen) && (
                <div className="connection-kind-grid">
                  {connectionKindOptions.map((option) => (
                    <button
                      key={option.kind}
                      type="button"
                      className="connection-kind-card"
                      onClick={() => selectConnectionKind(option.kind)}
                      disabled={busy || !api}
                    >
                      <div className="project-card-icon">
                        <ConnectionLogo kind={option.kind} />
                      </div>
                      <span className="project-card-name">{option.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {(elasticsearchFormOpen || dbFormOpen) && (
                <button
                  type="button"
                  className="connection-form-back"
                  onClick={() => { setElasticsearchFormOpen(false); setDbFormOpen(false); }}
                >
                  <ArrowLeft size={14} />
                  Back to connection types
                </button>
              )}
              <div className={`connection-form-panel${elasticsearchFormOpen || dbFormOpen ? ' open' : ''}`}>
                {renderElasticsearchForm()}
                {renderDbForm()}
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingApproval && (
        <div className="project-modal-backdrop">
          <div className="project-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Approval required">
            <div className="project-modal-header">
              <h2>Approve Action</h2>
            </div>
            <div className="project-modal-body">
              <p style={{ color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
                The agent wants to execute <strong style={{ color: 'var(--color-text-primary)' }}>{pendingApproval.toolName}</strong>
                {pendingApproval.purpose ? ` — ${pendingApproval.purpose}` : ''}
              </p>
              {pendingApproval.queryPreview && (
                <pre style={{
                  background: 'var(--code-bg)',
                  color: 'var(--code-text)',
                  padding: '12px',
                  borderRadius: 'var(--radius-control)',
                  marginBottom: '12px',
                  overflow: 'auto',
                  maxHeight: '200px',
                  fontSize: '12px',
                  lineHeight: '18px'
                }}>
                  {pendingApproval.queryPreview}
                </pre>
              )}
              <p className="connections-section-title" style={{ marginBottom: '12px' }}>
                Risk:{' '}
                <span style={{
                  color: pendingApproval.risk === 'high' ? 'var(--color-danger)' : pendingApproval.risk === 'medium' ? 'var(--color-warning)' : 'var(--color-success)'
                }}>
                  {pendingApproval.risk.toUpperCase()}
                </span>
              </p>
              <div className="connection-form-actions">
                <button type="button" className="primary-button" onClick={approveInterruption}>
                  Approve
                </button>
                <button type="button" className="connection-form-cancel" onClick={denyInterruption}>
                  Deny
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


    </main>
  );
}
