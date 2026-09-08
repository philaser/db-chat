import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { readableColumnLabel } from './formatting.js';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clipboard,
  Code2,
  Database,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  LockKeyhole,
  Maximize2,
  MoreHorizontal,
  Menu,
  MessageSquare,
  Pin,
  Search,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Rows3,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Table2,
  Trash2,
  Upload,
  UserRound,
  WifiOff,
  X
} from 'lucide-react';
import type {
  ChatMessage,
  ChatTurnSnapshot,
  ConnectionKnowledge,
  DatabaseSchema,
  FollowUpIntent,
  ModelChatMessage,
  QueryResult,
  QueryResultArtifact,
  TableInfo,
  WebChatSession,
  WebChatSummary
} from '../shared/types.js';
import { buildConnectionPayload, type ConnectionDraft } from './connectionPayload.js';
import { StructuredContent, splitContent } from './contentBlocks.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';

type ConnectionStatus = 'ready' | 'testing' | 'needs_test' | 'unavailable' | 'needs_attention';
type SettingsView = 'profile' | 'connections' | 'inference';

interface WebUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  createdAt: string;
}

interface WebConnection {
  id: string;
  label: string;
  kind: string;
  status: ConnectionStatus;
  readOnly: true;
  safeHost?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  ssl?: boolean;
  elasticsearchUrl?: string;
  elasticsearchVerifyCerts?: boolean;
  sqliteFileName?: string;
  hasSavedSecret: boolean;
  lastTestedAt?: string;
  tableCount?: number;
  lastError?: string;
  createdAt: string;
}

interface WebSettings {
  provider: 'openrouter';
  model: string;
  effortLevel: 'none' | 'low' | 'medium' | 'high' | 'max';
  activeConnectionId?: string;
}

interface BootstrapState {
  ready: boolean;
  user: WebUser;
  connections: WebConnection[];
  activeConnectionId?: string;
  settings: WebSettings;
  inference: {
    provider: 'openrouter';
    model: string;
    credentialSource: 'user' | 'internal' | 'none';
    hasUserKey: boolean;
    userKeyUiEnabled: boolean;
    status: 'ready' | 'unavailable';
  };
  capabilities: { queryResults: boolean; csvExport: boolean; charts: boolean };
  limits: {
    maxHistoryMessages: number;
    maxMessageChars: number;
    maxResultRows: number;
    maxResultBytes: number;
    maxSqliteUploadBytes?: number;
  };
}

export function getInferenceCallout(inference: BootstrapState['inference']): {
  available: boolean;
  title: string;
  description: string;
} {
  if (inference.status !== 'ready' || inference.credentialSource === 'none') {
    return {
      available: false,
      title: 'Inference unavailable',
      description: inference.userKeyUiEnabled
        ? 'Add an OpenRouter key to use chat.'
        : 'Answers are temporarily unavailable. Your connections and saved chats are still accessible.'
    };
  }

  return inference.credentialSource === 'user'
    ? {
        available: true,
        title: 'Provider key ready',
        description: 'DB Chat will use your stored OpenRouter key.'
      }
    : {
        available: true,
        title: 'Managed inference ready',
        description: 'DB Chat will use the service OpenRouter key.'
      };
}

interface StreamData {
  message?: ChatMessage | string;
  delta?: string;
  artifact?: QueryResultArtifact;
  artifacts?: QueryResultArtifact[];
  messageText?: string;
  summary?: string;
  purpose?: string;
  toolName?: string;
  elapsedMs?: number;
}

interface WorkingStatus {
  text: string;
  complete: boolean;
}

export function streamActivityText(type: string, data: StreamData): string {
  const message = typeof data.message === 'string' ? data.message : data.message?.content;
  const elapsed = typeof data.elapsedMs === 'number' ? ` · ${(data.elapsedMs / 1000).toFixed(1)}s` : '';
  const safeTool = data.toolName === 'sample_data' ? 'Inspecting sample rows'
    : data.toolName === 'get_schema_info' ? 'Inspecting the schema'
      : data.toolName === 'run_database_query' ? 'Running a read-only query'
        : data.toolName === 'visualize_data' ? 'Preparing a visualization'
          : undefined;
  if (type === 'tool-start') return (data.purpose ?? data.messageText ?? message ?? safeTool ?? 'Running a read-only operation') + elapsed;
  if (type === 'tool-progress') return data.messageText ?? data.summary ?? data.purpose ?? message ?? 'Working';
  if (type === 'tool-complete') return (data.summary ?? data.messageText ?? data.purpose ?? message ?? 'Operation complete') + elapsed;
  return data.messageText ?? message ?? data.summary ?? 'Working';
}

interface ApiFailure {
  error?: string;
}

const streamEventTypes = [
  'status',
  'thinking-delta',
  'text-delta',
  'tool-start',
  'tool-progress',
  'tool-complete',
  'result',
  'complete',
  'error',
  'aborted'
];

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const payload = await response.json().catch(() => ({})) as T & ApiFailure;
  if (response.status === 401 && !path.startsWith('/api/v1/auth/')) {
    window.dispatchEvent(new Event('dbchat:auth-required'));
    throw new ApiError('Your session has expired. Sign in again to continue.', response.status);
  }
  if (!response.ok) throw new ApiError(payload.error ?? 'The request could not be completed.', response.status);
  return payload;
}

function formatKind(kind?: string): string {
  if (!kind) return 'Database';
  const names: Record<string, string> = {
    postgres: 'PostgreSQL',
    mysql: 'MySQL',
    mongodb: 'MongoDB',
    elasticsearch: 'Elasticsearch',
    sqlite: 'SQLite'
  };
  return names[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatDate(value?: string): string {
  if (!value) return 'Not tested yet';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function serializeTsv(result: QueryResult): string {
  return [
    result.columns.join('\t'),
    ...result.rows.map((row) => result.columns.map((column) => {
      const value = formatValue(row[column]);
      return value === '—' ? '' : value;
    }).join('\t'))
  ].join('\n');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function serializeCsv(result: QueryResult): string {
  return [
    result.columns.map(csvCell).join(','),
    ...result.rows.map((row) => result.columns.map((column) => csvCell(row[column])).join(','))
  ].join('\r\n') + '\r\n';
}

function downloadText(contents: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'DB';
}

export function modelMessages(messages: ChatMessage[], maxMessages = 40, maxChars = 8000): ModelChatMessage[] {
  // Keep the durable transcript intact; only the model's working context is bounded.
  const recent = messages.slice(-Math.max(1, maxMessages));
  while (recent.length > 1 && recent[0].role !== 'user') recent.shift();
  return recent.map((message) => ({ role: message.role, content: message.content.slice(0, maxChars) }));
}

const sqlKeywords = new Set([
  'ALL', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CAST', 'CROSS', 'DESC', 'DISTINCT', 'ELSE',
  'END', 'EXISTS', 'FROM', 'FULL', 'GROUP', 'HAVING', 'IN', 'INNER', 'INTERSECT', 'IS', 'JOIN',
  'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'RIGHT',
  'SELECT', 'THEN', 'UNION', 'WHEN', 'WHERE', 'WITH'
]);

const sqlFunctions = new Set([
  'AVG', 'COALESCE', 'COUNT', 'DATE', 'GROUP_CONCAT', 'MAX', 'MIN', 'ROUND', 'SUM',
  'STRFTIME', 'SUBSTR', 'TOTAL'
]);

const sqlTokenPattern = /(--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|`(?:``|\\.|[^`])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w$]*\b|<>|!=|<=|>=|:=|[-+*/%=<>]|[(),.;])/g;

function sqlTokenClass(token: string, query: string, end: number): string | undefined {
  if (token.startsWith('--') || token.startsWith('#') || token.startsWith('/*')) return 'sql-comment';
  if (token.startsWith("'") || token.startsWith('"') || token.startsWith('`')) return 'sql-string';
  if (/^\d/.test(token)) return 'sql-number';
  if (/^[A-Za-z_]/.test(token)) {
    const upper = token.toUpperCase();
    if (sqlKeywords.has(upper)) return 'sql-keyword';
    if (sqlFunctions.has(upper) && /^\s*\(/.test(query.slice(end))) return 'sql-function';
    return 'sql-identifier';
  }
  if (/^[<>!=:+*/%=-]/.test(token)) return 'sql-operator';
  if (/^[(),.;]$/.test(token)) return 'sql-punctuation';
  return undefined;
}

function SqlCode({ query }: { query: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of query.matchAll(sqlTokenPattern)) {
    const token = match[0];
    const start = match.index ?? cursor;
    if (start > cursor) parts.push(query.slice(cursor, start));
    const className = sqlTokenClass(token, query, start + token.length);
    parts.push(className ? <span className={className} key={start}>{token}</span> : token);
    cursor = start + token.length;
  }
  if (cursor < query.length) parts.push(query.slice(cursor));
  return <pre aria-label="SQL query"><code>{parts}</code></pre>;
}

function extractSqlSources(query: string): string[] {
  const withoutCommentsAndStrings = query
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/#[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|\\.|[^'])*'/g, ' ')
    .replace(/"(?:""|\\.|[^"])*"/g, ' ')
    .replace(/`(?:``|\\.|[^`])*`/g, ' ');
  const names = new Set<string>();
  const pattern = /\b(?:from|join|update|into)\s+([A-Za-z_][\w$]*(?:\s*\.\s*[A-Za-z_][\w$]*)?)/gi;
  for (const match of withoutCommentsAndStrings.matchAll(pattern)) {
    const name = match[1]?.replace(/\s+/g, '');
    if (name) names.add(name);
  }
  return [...names];
}

function preserveSoftBreaks(children: ReactNode): ReactNode {
  if (typeof children === 'string') {
    const parts = children.split('\n');
    return parts.length === 1 ? children : parts.flatMap((part, index) => index === 0 ? [part] : [<br key={`soft-break-${index}`} />, part]);
  }
  if (Array.isArray(children)) return children.map((child) => preserveSoftBreaks(child));
  return children;
}

export function AssistantContent({ content }: { content: string }) {
  return (
    <>
      {splitContent(content).map((segment, index) => segment.type === 'blocks' && segment.blocks
        ? <StructuredContent key={index} blocks={segment.blocks} />
        : segment.type === 'pending'
          ? <div key={index} className="structured-pending" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" /> Preparing structured result…</div>
          : <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={{ p: ({ children }) => <p>{preserveSoftBreaks(children)}</p> }}>{segment.content}</ReactMarkdown>)}
    </>
  );
}

function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'ready': return 'Ready';
    case 'testing': return 'Testing';
    case 'needs_test': return 'Unavailable';
    case 'unavailable': return 'Unavailable';
    case 'needs_attention': return 'Unavailable';
  }
}

function Brand({ onNavigate }: { onNavigate?: (path: string) => void }) {
  return (
    <button type="button" className="brand-button" onClick={() => onNavigate?.('/')}>
      <span className="brand-mark" aria-hidden="true"><Database size={17} strokeWidth={2.2} /></span>
      <span className="brand-name">DB Chat</span>
    </button>
  );
}

function StatusLine({
  status,
  label,
  detail
}: {
  status: ConnectionStatus | 'healthy' | 'warning' | 'error' | 'info';
  label: string;
  detail?: string;
}) {
  const tone = status === 'ready' || status === 'healthy'
    ? 'positive'
    : status === 'unavailable' || status === 'needs_attention' || status === 'error'
      ? 'danger'
      : status === 'needs_test' || status === 'testing' || status === 'warning'
        ? 'warning'
        : 'info';
  return (
    <span className={'status-line status-' + tone}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
      {detail && <span className="status-detail">{detail}</span>}
    </span>
  );
}

function Button({
  variant = 'secondary',
  type = 'button',
  children,
  className = '',
  disabled = false,
  onClick,
  ariaLabel
}: {
  variant?: 'primary' | 'secondary' | 'quiet' | 'destructive';
  type?: 'button' | 'submit';
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      className={'button button-' + variant + (className ? ' ' + className : '')}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function Alert({
  tone = 'error',
  title,
  children,
  onDismiss
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === 'success' ? CircleCheck : tone === 'warning' ? CircleAlert : tone === 'info' ? ShieldCheck : CircleAlert;
  return (
    <div className={'alert alert-' + tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={17} aria-hidden="true" />
      <div className="alert-copy">
        {title && <strong>{title}</strong>}
        <span>{children}</span>
      </div>
      {onDismiss && <button type="button" className="icon-button alert-dismiss" onClick={onDismiss} aria-label="Dismiss message"><X size={16} /></button>}
    </div>
  );
}

export function AppBar({
  bootstrap,
  onNavigate,
  onRefresh,
  onLogout,
  onToggleNavigation,
  navigationOpen = false
}: {
  bootstrap: BootstrapState;
  onNavigate: (path: string) => void;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
  onToggleNavigation?: () => void;
  navigationOpen?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) setMenuOpen(false);
    };
    const dismissWithEscape = (event: Event) => {
      if ((event as globalThis.KeyboardEvent).key !== 'Escape') return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissWithEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissWithEscape);
    };
  }, [menuOpen]);

  return (
    <header className="app-bar">
      <div className="app-bar-left">
        <button type="button" className="icon-button workspace-navigation-toggle" aria-label="Workspace navigation" title="Workspace navigation" aria-expanded={navigationOpen} onClick={onToggleNavigation}><Menu size={20} /></button>
        <Brand onNavigate={onNavigate} />
        <span className="app-bar-divider" aria-hidden="true" />
        <span className="readonly-badge"><ShieldCheck size={16} aria-hidden="true" /> Read-only</span>
      </div>
      <div className="app-bar-right">
        <div className="account-menu" ref={menuRef}>
          <button
            ref={triggerRef}
            type="button"
            className="account-trigger"
            aria-label={bootstrap.user.displayName}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="avatar" aria-hidden="true">{initials(bootstrap.user.displayName)}</span>
            <span className="account-trigger-name">{bootstrap.user.displayName}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="account-popover" role="menu">
              <div className="account-popover-identity">
                <span className="avatar avatar-large" aria-hidden="true">{initials(bootstrap.user.displayName)}</span>
                <div>
                  <strong>{bootstrap.user.displayName}</strong>
                  <span>{bootstrap.user.email}</span>
                </div>
              </div>
              <div className="popover-rule" />
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNavigate('/settings'); }}>
                <Settings size={16} /> Settings
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void onRefresh(); }}>
                <RefreshCw size={16} /> Refresh workspace
              </button>
              <div className="popover-rule" />
              <button type="button" role="menuitem" className="menu-destructive" onClick={() => { setMenuOpen(false); void onLogout(); }}>
                <LogOut size={16} /> Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function ChatSidebarRow({
  chat,
  selected,
  onSelect,
  onRename,
  onDelete
  ,onPin
}: {
  chat: WebChatSummary;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onPin?: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (restoreFocus = false) => {
    setMenuOpen(false);
    setMode('menu');
    setError('');
    setTitle(chat.title);
    if (restoreFocus) window.setTimeout(() => actionsRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!menuOpen || mode === 'delete') return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [chat.title, menuOpen, mode]);

  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim().replace(/\s+/g, ' ');
    if (!nextTitle) {
      setError('Enter a chat name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onRename(nextTitle);
      closeMenu();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The chat could not be renamed.');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await onDelete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The chat could not be deleted.');
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className={'sidebar-chat-item' + (selected ? ' selected' : '')}>
      <button
        type="button"
        className="sidebar-row sidebar-chat-row"
        onClick={onSelect}
        aria-current={selected ? 'page' : undefined}
        title={chat.title}
      >
        <MessageSquare size={20} strokeWidth={1.6} aria-hidden="true" />
        <span className="sidebar-row-label">{chat.title}</span>
        <span className="sr-only">{chat.messageCount} messages, updated {formatDate(chat.updatedAt)}</span>
      </button>
      <button
        ref={actionsRef}
        type="button"
        className="sidebar-chat-actions"
        aria-label={`Actions for ${chat.title}`}
        title={`Actions for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen((current) => !current);
          setMode('menu');
          setError('');
          setTitle(chat.title);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {menuOpen && mode !== 'delete' && (
        <div className="sidebar-chat-popover">
          {mode === 'menu' && (
            <div role="menu">
              <button type="button" role="menuitem" onClick={() => setMode('rename')}><Pencil size={14} /> Rename</button>
              {onPin && <button type="button" role="menuitem" onClick={() => void onPin()}><Pin size={14} /> {chat.pinned ? 'Unpin' : 'Pin'}</button>}
              <button type="button" role="menuitem" className="menu-destructive" onClick={() => setMode('delete')}><Trash2 size={14} /> Delete</button>
            </div>
          )}
          {mode === 'rename' && (
            <form className="sidebar-chat-rename" onSubmit={(event) => void submitRename(event)}>
              <label htmlFor={`rename-${chat.id}`}>Chat name</label>
              <input ref={inputRef} id={`rename-${chat.id}`} value={title} maxLength={72} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
              {error && <p role="alert">{error}</p>}
              <div className="sidebar-chat-confirm-actions">
                <button type="button" onClick={() => closeMenu()}>Cancel</button>
                <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          )}
        </div>
      )}
      <ConfirmDialog open={menuOpen && mode === 'delete'} title="Delete this chat?" confirmLabel="Delete chat" pending={busy} onCancel={() => closeMenu(true)} onConfirm={() => void confirmDelete()}>
        <p>“{chat.title}” will be permanently deleted.</p>
        {error && <p role="alert">{error}</p>}
      </ConfirmDialog>
    </div>
  );
}

function WorkspaceSidebar({
  bootstrap,
  route,
  onNavigate,
  onSelectConnection,
  onNewChat,
  chats,
  selectedChatId,
  onSelectChat,
  onRenameChat,
  onDeleteChat
  ,onPinChat
}: {
  bootstrap: BootstrapState;
  route: string;
  onNavigate: (path: string) => void;
  onSelectConnection: (connectionId: string) => Promise<void>;
  onNewChat: () => void;
  chats: WebChatSummary[];
  selectedChatId: string | null;
  onSelectChat: (chat: WebChatSummary) => void;
  onRenameChat: (chat: WebChatSummary, title: string) => Promise<void>;
  onDeleteChat: (chat: WebChatSummary) => Promise<void>;
  onPinChat: (chat: WebChatSummary) => Promise<void>;
}) {
  const [chatSearch, setChatSearch] = useState('');
  const [connectionFilter, setConnectionFilter] = useState('');
  const [visibleChats, setVisibleChats] = useState(chats);
  const [searching, setSearching] = useState(false);
  useEffect(() => { if (!chatSearch && !connectionFilter) setVisibleChats(chats); }, [chats, chatSearch, connectionFilter]);
  useEffect(() => {
    if (!chatSearch.trim() && !connectionFilter) return;
    const timeout = window.setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({ limit: '50' });
      if (chatSearch.trim()) params.set('q', chatSearch.trim());
      if (connectionFilter) params.set('connectionId', connectionFilter);
      void api<{ chats: WebChatSummary[] }>('/api/v1/chats?' + params).then(({ chats: matches }) => setVisibleChats(matches)).catch(() => setVisibleChats([])).finally(() => setSearching(false));
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [chatSearch, connectionFilter]);
  return (
    <aside className="workspace-sidebar" aria-label="Workspace navigation">
      <div className="sidebar-main">
        <button type="button" className="sidebar-new-chat" onClick={onNewChat}>
          <span className="sidebar-plus" aria-hidden="true"><Plus size={17} /></span>
          <span>New chat</span>
        </button>

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <p className="sidebar-section-label">Connections</p>
            {bootstrap.connections.length > 0 ? bootstrap.connections.map((connection) => {
              const selected = connection.id === bootstrap.activeConnectionId;
              return (
                <button
                  type="button"
                  className={'sidebar-row sidebar-connection-row' + (selected ? ' selected' : '')}
                  key={connection.id}
                  onClick={() => void onSelectConnection(connection.id)}
                  aria-current={selected ? 'true' : undefined}
                >
                  <Database size={21} strokeWidth={1.7} aria-hidden="true" />
                  <span className="sidebar-row-label">{connection.label}</span>
                  <span className={'sidebar-status sidebar-status-' + connection.status} aria-hidden="true" />
                  <span className="sr-only">{connectionStatusLabel(connection.status)}</span>
                </button>
              );
            }) : (
              <button type="button" className="sidebar-row sidebar-empty-row" onClick={() => onNavigate('/settings/connections/new')}>
                <Plus size={18} aria-hidden="true" />
                <span className="sidebar-row-label">Add connection</span>
              </button>
            )}
          </div>

          <div className="sidebar-section">
            <p className="sidebar-section-label">Chats</p>
            <label className="sidebar-chat-search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search chats</span><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chats" /></label>
            <label className="sidebar-chat-filter"><span className="sr-only">Filter chats by connection</span><select value={connectionFilter} onChange={(event) => setConnectionFilter(event.target.value)}><option value="">All connections</option>{bootstrap.connections.map((connection) => <option value={connection.id} key={connection.id}>{connection.label}</option>)}</select></label>
            {searching ? <p className="sidebar-empty-note" role="status">Searching…</p> : visibleChats.length > 0 ? visibleChats.map((chat) => {
              const selected = selectedChatId === chat.id || route === '/chat/' + chat.id;
              return <ChatSidebarRow key={chat.id} chat={chat} selected={selected} onSelect={() => onSelectChat(chat)} onRename={(title) => onRenameChat(chat, title)} onDelete={() => onDeleteChat(chat)} onPin={() => onPinChat(chat)} />;
            }) : (
              <p className="sidebar-empty-note">{chatSearch || connectionFilter ? 'No matching chats' : 'No chats yet'}</p>
            )}
          </div>
        </nav>
      </div>

      <button
        type="button"
        className={'sidebar-settings' + (route.startsWith('/settings') ? ' selected' : '')}
        onClick={() => onNavigate('/settings')}
        aria-current={route.startsWith('/settings') ? 'page' : undefined}
      >
        <Settings size={22} strokeWidth={1.6} aria-hidden="true" />
        <span>Settings</span>
      </button>
    </aside>
  );
}

function PublicShell({
  children,
  onNavigate,
  actionLabel,
  actionPath,
  secondaryActionLabel,
  secondaryActionPath,
  note
}: {
  children: React.ReactNode;
  onNavigate: (path: string) => void;
  actionLabel?: string;
  actionPath?: string;
  secondaryActionLabel?: string;
  secondaryActionPath?: string;
  note?: string;
}) {
  return (
    <div className="public-shell">
      <header className="public-nav">
        <Brand onNavigate={onNavigate} />
        <div className="public-nav-actions">
          {note && <span className="public-nav-note"><ShieldCheck size={16} aria-hidden="true" /> {note}</span>}
          {secondaryActionLabel && secondaryActionPath && (
            <button type="button" className="public-nav-link" onClick={() => onNavigate(secondaryActionPath)}>{secondaryActionLabel}</button>
          )}
          {actionLabel && actionPath && (
            <Button variant="secondary" className="public-nav-action" onClick={() => onNavigate(actionPath)}>{actionLabel}</Button>
          )}
        </div>
      </header>
      {children}
      <footer className="public-footer">
        <span>DB Chat Web</span>
        <span>Private by default · <a href="/privacy" onClick={(event) => { event.preventDefault(); onNavigate('/privacy'); }}>Privacy and data</a> · Read-only queries</span>
      </footer>
    </div>
  );
}

function PublicPolicy({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <PublicShell
      onNavigate={onNavigate}
      secondaryActionLabel="Log in"
      secondaryActionPath="/login"
      actionLabel="Create account"
      actionPath="/signup"
    >
      <main className="policy-page">
        <p className="overline">PRIVACY AND DATA</p>
        <h1>Privacy and data</h1>
        <p>DB Chat sends prompts, relevant schema context, and bounded query results to the selected inference provider. Database credentials remain on the hosted server and are never shown in the browser.</p>
        <div className="policy-sections">
          <section><h2>Read-only queries</h2><p>The web product allows schema inspection, sampling, and bounded read queries. It does not run write, alter, or delete operations.</p></section>
          <section><h2>Your connections</h2><p>Connection details belong to your account. Saved secrets are encrypted server-side and represented in the interface only as configured, missing, or needs-update states.</p></section>
          <section><h2>Provider keys</h2><p>DB Chat uses the managed service key when no user key is configured. Optional user keys are stored server-side and are never returned after saving.</p></section>
        </div>
      </main>
    </PublicShell>
  );
}

function Landing({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <PublicShell
      onNavigate={onNavigate}
      secondaryActionLabel="Log in"
      secondaryActionPath="/login"
      actionLabel="Create account"
      actionPath="/signup"
    >
      <main className="public-page public-landing">
        <section className="landing-intro">
          <p className="overline">DATABASE QUESTIONS</p>
          <h1>Ask your database.</h1>
          <p className="landing-copy">
            Connect a database, ask a question, inspect the query and results.
          </p>
          <div className="landing-actions">
            <Button variant="primary" onClick={() => onNavigate('/signup')}>Get started</Button>
            <Button variant="secondary" onClick={() => onNavigate('/login')}>Log in</Button>
          </div>
          <div className="landing-proof">
            <span><ShieldCheck size={15} /> Read-only queries</span>
            <span><Database size={15} /> Source context</span>
            <span><Rows3 size={15} /> Inspectable results</span>
          </div>
        </section>
        <aside className="landing-preview" aria-label="Example result">
          <div className="preview-overline">EXAMPLE RESULT</div>
          <div className="preview-question">Which channels grew the most this quarter?</div>
          <div className="preview-answer">
            <span className="preview-answer-label">DB Chat</span>
            <strong>Organic search grew fastest, up 28% quarter over quarter.</strong>
          </div>
          <div className="preview-table">
            <div><span>Channel</span><span>Growth</span></div>
            <div><span>Organic search</span><strong>28.4%</strong></div>
            <div><span>Partner</span><strong>16.8%</strong></div>
            <div><span>Referral</span><strong>9.2%</strong></div>
          </div>
        </aside>
      </main>
    </PublicShell>
  );
}

export function AuthScreen({
  mode,
  onNavigate,
  onComplete
}: {
  mode: 'signup' | 'login';
  onNavigate: (path: string) => void;
  onComplete: (data: { email: string; password: string; displayName?: string }) => Promise<void | { confirmationRequired?: boolean }>;
}) {
  const signup = mode === 'signup';
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [terms, setTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (signup && password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    if (signup && !terms) {
      setError('Acknowledge the privacy and data policy to continue.');
      return;
    }
    setPending(true);
    try {
      const result = await onComplete({ email, password, displayName: displayName || undefined });
      if (result?.confirmationRequired) {
        setVerificationSent(true);
        setPassword('');
        setConfirmation('');
        setPending(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request could not be completed.');
      setPending(false);
    }
  };

  return (
    <PublicShell
      onNavigate={onNavigate}
      actionLabel={signup ? 'Log in' : 'Create account'}
      actionPath={signup ? '/login' : '/signup'}
      note="Read-only queries"
    >
      <main className="auth-page">
        <section className="auth-form-stage">
          <div className="auth-form-heading">
            <p className="overline">{signup ? 'Create account' : 'Welcome back'}</p>
            <h1>{signup ? 'Create your account' : 'Log in'}</h1>
            <p>{signup ? 'Use an email address and password.' : 'Use your account to access saved connections and chats.'}</p>
          </div>
          {error && <Alert title="Check the form">{error}</Alert>}
          {verificationSent && <Alert tone="success" title="Check your email">Open the confirmation link to finish creating your account, then log in.</Alert>}
          {!verificationSent && <form className="stack-form" onSubmit={(event) => void submit(event)}>
            {signup && (
              <Field label="Display name" name="displayName" value={displayName} onChange={setDisplayName} placeholder="Display name" autoComplete="name" />
            )}
            <Field label="Email" name="email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoComplete="email" required />
            <SecretField label="Password" name="password" value={password} onChange={setPassword} show={showPassword} onToggle={() => setShowPassword((shown) => !shown)} autoComplete={signup ? 'new-password' : 'current-password'} helper={signup ? 'At least 8 characters.' : undefined} required />
            {signup && (
              <SecretField label="Confirm password" name="confirmation" value={confirmation} onChange={setConfirmation} show={showConfirmation} onToggle={() => setShowConfirmation((shown) => !shown)} autoComplete="new-password" required />
            )}
            {signup && (
              <label className="checkbox-row">
                <input type="checkbox" checked={terms} onChange={(event) => setTerms(event.target.checked)} />
                <span>I acknowledge the <a href="/privacy" onClick={(event) => { event.preventDefault(); onNavigate('/privacy'); }}>privacy and data policy</a></span>
              </label>
            )}
            <Button variant="primary" type="submit" className="button-wide" disabled={pending}>
              {pending ? <><LoaderCircle className="spin" size={16} /> {signup ? 'Creating account' : 'Signing in'}</> : <>{signup ? 'Create account' : 'Log in'} <ArrowRight size={16} /></>}
            </Button>
          </form>}
          {!signup && <p className="auth-switch auth-switch-recovery"><button className="quiet-action auth-text-action" type="button" onClick={() => onNavigate('/forgot-password')}>Forgot password?</button></p>}
          <p className="auth-switch auth-switch-account">
            {signup ? 'Already have an account?' : 'New to DB Chat?'}{' '}
            <button className="quiet-action auth-text-action" type="button" onClick={() => onNavigate(signup ? '/login' : '/signup')}>{signup ? 'Log in' : 'Create an account'}</button>
          </p>
        </section>
      </main>
    </PublicShell>
  );
}

export function AccountRecoveryScreen({ mode, onNavigate, onVerified }: {
  mode: 'forgot' | 'confirm' | 'reset';
  onNavigate: (path: string) => void;
  onVerified: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(mode === 'confirm');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const verificationRef = useRef<Promise<'recovery' | 'account'> | null>(null);
  useEffect(() => {
    if (mode !== 'confirm') return;
    let cancelled = false;
    if (!verificationRef.current) {
      const params = new URLSearchParams(window.location.search);
      const tokenHash = params.get('token_hash');
      const type = params.get('type');
      // Remove one-use credentials from browser history before any navigation.
      window.history.replaceState({}, '', '/auth/confirm');
      verificationRef.current = !tokenHash || !['signup', 'recovery', 'email'].includes(type ?? '')
        ? Promise.reject(new Error('This confirmation link is incomplete. Request a new email link.'))
        : api('/api/v1/auth/verify', { method: 'POST', body: JSON.stringify({ tokenHash, type }) }).then(() => type === 'recovery' ? 'recovery' : 'account');
    }
    void verificationRef.current.then(async result => {
      if (cancelled) return;
      if (result === 'recovery') onNavigate('/reset-password');
      else { await onVerified(); if (!cancelled) onNavigate('/'); }
    }).catch(reason => { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'The link could not be verified.'); setPending(false); } });
    return () => { cancelled = true; };
  }, [mode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (mode === 'reset' && (password.length < 8 || password !== confirmation)) {
      setError(password.length < 8 ? 'Use at least 8 characters.' : 'Passwords do not match.'); return;
    }
    setPending(true);
    try {
      if (mode === 'forgot') {
        await api('/api/v1/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
        setStatus('If an account can receive recovery email, a reset link will arrive shortly. Check your inbox and spam folder.');
      } else {
        await api('/api/v1/auth/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
        setPassword(''); setConfirmation('');
        setStatus('Your password has been updated. You can log in with your new password.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request could not be completed.'); }
    finally { setPending(false); }
  };
  const title = mode === 'forgot' ? 'Reset your password' : mode === 'confirm' ? 'Confirming your email' : 'Choose a new password';
  return <PublicShell onNavigate={onNavigate} actionLabel="Log in" actionPath="/login" note="Your account">
    <main className="auth-page">
      <section className="auth-intro"><p className="overline">Account access</p><h1>{title}</h1><p>Keep access to your saved connections and conversations.</p></section>
      <section className="auth-form-stage">
        {error && <Alert title="Account access">{error}</Alert>}
        {status && <Alert tone="success">{status}</Alert>}
        {mode === 'confirm' ? <><p role="status">{pending ? 'Checking your confirmation link…' : 'Request a new link if this one has expired or was already used.'}</p>{!pending && <Button onClick={() => onNavigate('/forgot-password')}>Request a recovery link</Button>}</> : !status && <form className="stack-form" onSubmit={event => void submit(event)}>
          {mode === 'forgot' ? <Field label="Email" name="recovery-email" type="email" value={email} onChange={setEmail} autoComplete="email" required /> : <>
            <SecretField label="New password" name="recovery-password" value={password} onChange={setPassword} show={showPassword} onToggle={() => setShowPassword(value => !value)} autoComplete="new-password" helper="At least 8 characters." required />
            <Field label="Confirm password" name="recovery-confirmation" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" required />
          </>}
          <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Please wait…' : mode === 'forgot' ? 'Send reset link' : 'Update password'}</Button>
        </form>}
        <p className="auth-switch"><button type="button" onClick={() => onNavigate('/login')}>Back to log in</button></p>
      </section>
    </main>
  </PublicShell>;
}

function Field({
  label,
  name,
  value,
  onChange,
  placeholder,
  type = 'text',
  helper,
  required = false,
  autoComplete
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  helper?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input name={name} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} autoComplete={autoComplete} />
      {helper && <span className="field-helper">{helper}</span>}
    </label>
  );
}

function SecretField({
  label,
  name,
  value,
  onChange,
  show,
  onToggle,
  autoComplete,
  helper,
  required = false
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete?: string;
  helper?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={name}>{label}</label>
      <span className="secret-input-wrap">
        <input id={name} name={name} type={show ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} required={required} autoComplete={autoComplete} />
        <button type="button" className="input-action" onClick={onToggle} aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
      {helper && <span className="field-helper">{helper}</span>}
    </div>
  );
}

function NoConnectionState({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="no-connection-state">
      <div className="empty-emblem"><Database size={22} /></div>
      <p className="overline">NO CONNECTION</p>
      <h1>Add a connection.</h1>
      <p>Add a connection before asking a question. Queries are read-only and bounded.</p>
      <Button variant="primary" onClick={() => onNavigate('/settings/connections/new')}>Add your first connection <ArrowRight size={16} /></Button>
      <span className="safe-note"><ShieldCheck size={14} /> Credentials are encrypted and are not shown after saving.</span>
    </section>
  );
}

function ConnectionAttention({
  connection,
  onNavigate
}: {
  connection: WebConnection;
  onNavigate: (path: string) => void;
}) {
  return (
    <section className="connection-attention">
      <StatusLine status={connection.status} label={connectionStatusLabel(connection.status)} />
      <h2>{connection.label} is unavailable.</h2>
      <p>{connection.lastError ?? 'This connection could not be reached. Review its settings before asking DB Chat to run a query.'}</p>
      <div className="inline-actions">
        <Button variant="primary" onClick={() => onNavigate('/settings/connections/' + connection.id)}>Manage connection <ArrowRight size={15} /></Button>
        <Button variant="quiet" onClick={() => onNavigate('/settings/connections')}>View connections</Button>
      </div>
    </section>
  );
}

function EntryStage({
  bootstrap,
  onPrompt
}: {
  bootstrap: BootstrapState;
  onPrompt: (prompt: string) => void;
}) {
  const active = bootstrap.connections.find((connection) => connection.id === bootstrap.activeConnectionId);
  const fallbackPrompts = ['Summarize what this database contains.', 'Check the data for quality issues.', 'Show the largest useful categories.'];
  const [prompts, setPrompts] = useState(fallbackPrompts);
  const [loadingPrompts, setLoadingPrompts] = useState(Boolean(active));
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoadingPrompts(true);
    void api<{ suggestions: string[] }>('/api/v1/connections/' + encodeURIComponent(active.id) + '/suggestions')
      .then(({ suggestions }) => { if (!cancelled && suggestions.length) setPrompts(suggestions.slice(0, 5)); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoadingPrompts(false); });
    return () => { cancelled = true; };
  }, [active?.id]);
  return (
    <div className="entry-stage">
      <div className="entry-context">
        <div className="entry-context-primary">
          <Database size={18} aria-hidden="true" />
          <span className="entry-context-identity"><strong>{active?.label ?? 'Connection selected'}</strong><small>{formatKind(active?.kind)} · Read-only</small></span>
          <StatusLine status="healthy" label="Ready" />
        </div>
        <span className="entry-context-limit">Up to {bootstrap.limits.maxResultRows} rows per result</span>
      </div>
      <div className="entry-heading">
        <p className="overline">NEW QUESTION</p>
        <h1>Ask a question.</h1>
        <p>DB Chat will inspect the schema, run a bounded read-only query, and return the query and results.</p>
      </div>
      <div className="suggestion-heading">
        <span className="overline">SUGGESTED QUESTIONS</span>
        {loadingPrompts && <span className="suggestion-loading" role="status">Checking this schema…</span>}
      </div>
      <div className="suggestion-list">
        {prompts.map((prompt) => (
          <button type="button" className="suggestion-row" key={prompt} onClick={() => onPrompt(prompt)}>
            <span className="suggestion-copy">
              <strong>{prompt}</strong>
            </span>
            <ArrowUpRight size={17} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

type InspectorTab = 'results' | 'query' | 'schema';

const DEFAULT_INSPECTOR_WIDTH = 400;
const MIN_INSPECTOR_WIDTH = 360;
const MAX_INSPECTOR_WIDTH = 480;
const INSPECTOR_RESIZE_STEP = 24;
const canAutoOpenInspector = () => window.innerWidth > 1100;

function clampInspectorWidth(width: number): number {
  return Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width));
}

export function resultLinkLabel(artifact: QueryResultArtifact): string {
  const purpose = artifact.purpose?.trim().replace(/[.!?]+$/, '');
  return purpose && purpose.length <= 64 ? `View results: ${purpose}` : 'View results';
}

export { readableColumnLabel } from './formatting.js';

export function DataInspector({
  artifact,
  connectionLabel,
  connectionId,
  onClose,
  inspectorWidth,
  onInspectorWidthChange
}: {
  artifact: QueryResultArtifact;
  connectionLabel: string;
  connectionId: string;
  onClose: () => void;
  inspectorWidth: number;
  onInspectorWidthChange: (width: number) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('results');
  const [copied, setCopied] = useState(false);
  const [schemaView, setSchemaView] = useState<'overview' | 'tables' | 'sources'>('overview');
  const [schema, setSchema] = useState<DatabaseSchema | null>(() => artifact.schema ?? null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState('');
  const [schemaAttempt, setSchemaAttempt] = useState(0);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [resizing, setResizing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resultSearch, setResultSearch] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inspectorRef.current?.querySelector<HTMLButtonElement>('.inspector-close')?.focus();
    return () => { if (origin?.isConnected) origin.focus(); };
  }, []);
  const result = artifact.result;
  const visibleColumns = result.columns.filter((column) => !hiddenColumns.includes(column));
  const visibleRows = useMemo(() => {
    const needle = resultSearch.trim().toLowerCase();
    const filtered = needle ? result.rows.filter((row) => visibleColumns.some((column) => formatValue(row[column]).toLowerCase().includes(needle))) : [...result.rows];
    if (!sortColumn) return filtered;
    return filtered.sort((left, right) => {
      const a = left[sortColumn]; const b = right[sortColumn];
      const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
      return sortDirection === 'asc' ? order : -order;
    });
  }, [result.rows, resultSearch, sortColumn, sortDirection, hiddenColumns]);
  const visibleResult: QueryResult = { ...result, columns: visibleColumns, rows: visibleRows, rowCount: visibleRows.length };
  const tabs: Array<{ id: InspectorTab; label: string }> = [
    { id: 'results', label: 'Results' },
    { id: 'query', label: 'Query' },
    { id: 'schema', label: 'Schema' }
  ];
  const querySources = useMemo(() => extractSqlSources(artifact.query), [artifact.query]);
  const filteredTables = useMemo(() => {
    const search = schemaSearch.trim().toLowerCase();
    return (schema?.tables ?? []).filter((table) => !search || table.name.toLowerCase().includes(search) || table.columns.some((column) => column.name.toLowerCase().includes(search)));
  }, [schema, schemaSearch]);
  const sourceTables = useMemo(() => querySources.map((source) => ({
    source,
    table: schema?.tables.find((table) => table.name.toLowerCase() === source.split('.').at(-1)?.toLowerCase())
  })), [querySources, schema]);

  useEffect(() => {
    setSchema(artifact.schema ?? null);
    setSchemaLoading(false);
    setSchemaError('');
    setSchemaAttempt(0);
    setSchemaView('overview');
    setSchemaSearch('');
    setResultSearch('');
    setSortColumn(null);
    setSortDirection('asc');
    setHiddenColumns([]);
    setColumnsOpen(false);
  }, [artifact.queryId, artifact.schema, connectionId]);

  useEffect(() => {
    if (tab !== 'schema' || artifact.schema || schema) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setSchemaLoading(true);
    setSchemaError('');
    void api<{ schema: DatabaseSchema }>('/api/v1/connections/' + encodeURIComponent(connectionId) + '/introspect', { signal: controller.signal })
      .then((payload) => {
        if (cancelled) return;
        setSchema(payload.schema);
        setSchemaLoading(false);
      })
      .catch((reason) => {
        if (cancelled) return;
        setSchemaError(reason?.name === 'AbortError' ? 'The schema took too long to load.' : reason instanceof Error ? reason.message : 'The schema could not be loaded.');
        setSchemaLoading(false);
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [artifact.schema, connectionId, schema, schemaAttempt, tab]);

  const copy = async (value: string, label: 'result' | 'query') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
    if (label === 'query') setTab('query');
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeCsv(visibleResult)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.queryId + '.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: InspectorTab) => {
    const index = tabs.findIndex((item) => item.id === current);
    const nextIndex = event.key === 'ArrowRight'
      ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft'
        ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setTab(next.id);
    window.setTimeout(() => document.getElementById('inspector-tab-' + next.id)?.focus(), 0);
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: inspectorWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const delta = event.clientX - resizeRef.current.startX;
    onInspectorWidthChange(clampInspectorWidth(resizeRef.current.startWidth - delta));
  };

  const handleResizePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidth = event.key === 'ArrowLeft'
      ? inspectorWidth + INSPECTOR_RESIZE_STEP
      : event.key === 'ArrowRight'
        ? inspectorWidth - INSPECTOR_RESIZE_STEP
        : event.key === 'Home'
          ? MIN_INSPECTOR_WIDTH
          : event.key === 'End'
            ? MAX_INSPECTOR_WIDTH
            : null;
    if (nextWidth === null) return;
    event.preventDefault();
    onInspectorWidthChange(clampInspectorWidth(nextWidth));
  };

  const openSchemaView = (view: 'tables' | 'sources') => {
    setSchemaView(view);
    setTab('schema');
  };

  return (
    <aside ref={inspectorRef} id="data-inspector-panel" className={'data-inspector' + (expanded ? ' inspector-expanded' : '')} aria-label="Data inspector" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && window.innerWidth <= 760) {
        const controls = Array.from(inspectorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"], input, textarea') ?? []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div
        className={'inspector-resize-handle' + (resizing ? ' is-resizing' : '')}
        role="separator"
        aria-label="Resize data inspector"
        aria-controls="data-inspector-panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_INSPECTOR_WIDTH}
        aria-valuemax={MAX_INSPECTOR_WIDTH}
        aria-valuenow={Math.round(inspectorWidth)}
        aria-valuetext={Math.round(inspectorWidth) + ' pixels wide'}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="inspector-header">
        <div className="inspector-title-row">
          <h2>Data</h2>
          <div className="inspector-title-actions">
            <button type="button" className="icon-button inspector-expand" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? 'Restore data inspector width' : 'Expand data inspector'} aria-pressed={expanded} title={expanded ? 'Restore width' : 'Expand results'}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
            <button type="button" className="icon-button inspector-close" onClick={onClose} aria-label="Close data inspector" title="Close data inspector"><X size={20} /></button>
          </div>
        </div>
        <div className="inspector-source"><Database size={19} strokeWidth={1.7} aria-hidden="true" /><span>{connectionLabel}</span><span>·</span><span className="inspector-readonly">read-only</span></div>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Data views">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            id={'inspector-tab-' + item.id}
            className={'inspector-tab' + (tab === item.id ? ' active' : '')}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={'inspector-panel-' + item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => moveTab(event, item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="inspector-meta">
        {tab === 'results' && <span>{result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'} · {result.columns.length} {result.columns.length === 1 ? 'column' : 'columns'} · {result.elapsedMs} ms</span>}
        {tab === 'query' && <span>Read-only query</span>}
        {tab === 'schema' && <span>Connected schema</span>}
      </div>
      <div className="inspector-body">
        {tab === 'results' && (
          <div id="inspector-panel-results" role="tabpanel" aria-labelledby="inspector-tab-results" className="inspector-panel">
            {result.truncated && <p className="result-limit-note" role="status">Showing the first {result.rows.length} rows. This result is limited; narrow your question for a complete subset. Copy and CSV include these rows only.</p>}
            <div className="result-controls" aria-label="Result controls">
              <label className="result-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Filter loaded rows</span><input value={resultSearch} onChange={(event) => setResultSearch(event.target.value)} placeholder="Filter loaded rows" /></label>
              <div className="result-column-control">
                <button type="button" className="result-control-button" onClick={() => setColumnsOpen((open) => !open)} aria-expanded={columnsOpen}><SlidersHorizontal size={15} aria-hidden="true" /> Columns</button>
                {columnsOpen && <fieldset className="result-column-menu"><legend>Visible columns</legend>{result.columns.map((column) => <label key={column}><input type="checkbox" checked={!hiddenColumns.includes(column)} onChange={() => setHiddenColumns((current) => current.includes(column) ? current.filter((item) => item !== column) : [...current, column])} /> {readableColumnLabel(column)}</label>)}</fieldset>}
              </div>
              <span className="result-scope">{visibleRows.length} of {result.rows.length} loaded rows</span>
            </div>
            {result.rows.length === 0 ? (
              <p className="result-empty">No rows returned.</p>
            ) : (
              <div className="result-table-wrap" tabIndex={0} aria-label="Scrollable query result">
                <table className="result-table">
                  <caption className="sr-only">Query results from {connectionLabel}</caption>
                  <thead><tr>{visibleColumns.map((column) => <th scope="col" key={column}><button type="button" className="result-sort" onClick={() => { if (sortColumn === column) setSortDirection((value) => value === 'asc' ? 'desc' : 'asc'); else { setSortColumn(column); setSortDirection('asc'); } }} aria-label={`Sort by ${readableColumnLabel(column)}${sortColumn === column ? `, ${sortDirection}ending` : ''}`}>{readableColumnLabel(column)}{sortColumn === column ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead>
                  <tbody>
                    {visibleRows.map((row, index) => (
                      <tr key={artifact.queryId + '-' + index}>
                        {visibleColumns.map((column) => {
                          const value = row[column];
                          const numeric = typeof value === 'number';
                          const empty = value === null || value === undefined;
                          return <td key={column} className={numeric ? 'numeric' : empty ? 'empty-value' : undefined} title={formatValue(value)}>{formatValue(value)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {tab === 'query' && (
          <div id="inspector-panel-query" role="tabpanel" aria-labelledby="inspector-tab-query" className="inspector-panel inspector-query-panel">
            <SqlCode query={artifact.query} />
          </div>
        )}
        {tab === 'schema' && (
          <div id="inspector-panel-schema" role="tabpanel" aria-labelledby="inspector-tab-schema" className="inspector-panel inspector-schema-panel">
            {schemaView === 'overview' ? (
              <div className="schema-index">
                <button type="button" className="schema-row" onClick={() => openSchemaView('tables')}>
                  <Table2 size={16} aria-hidden="true" />
                  <span><strong>Tables</strong><small>{schema ? `${schema.tables.length} tables in ${connectionLabel}` : 'Load tables from this connection'}</small></span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
                <button type="button" className="schema-row" onClick={() => openSchemaView('sources')}>
                  <Code2 size={16} aria-hidden="true" />
                  <span><strong>Query sources</strong><small>{querySources.length ? `${querySources.length} source${querySources.length === 1 ? '' : 's'} in this query` : 'No table sources found in this query'}</small></span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="schema-detail">
                <button type="button" className="schema-back" onClick={() => setSchemaView('overview')}><ChevronRight size={14} aria-hidden="true" /> Schema overview</button>
                <div className="schema-detail-heading">
                  <div>
                    <p className="schema-kicker">{schemaView === 'tables' ? 'TABLES' : 'QUERY SOURCES'}</p>
                    <h3>{schemaView === 'tables' ? 'Tables' : 'Query sources'}</h3>
                  </div>
                  {schema && <span>{schemaView === 'tables' ? schema.tables.length : querySources.length}</span>}
                </div>
                {schemaView === 'tables' && <div className="schema-search"><span className="sr-only">Search schema</span><input type="search" value={schemaSearch} onChange={(event) => setSchemaSearch(event.target.value)} placeholder="Search tables or fields" aria-label="Search schema" /></div>}
                {schemaLoading && <p className="schema-state">Loading schema…</p>}
                {schemaError && <div className="schema-state schema-state-error" role="alert"><span>{schemaError}</span><button type="button" className="schema-retry" onClick={() => { setSchemaError(''); setSchemaAttempt((attempt) => attempt + 1); }}>Retry</button></div>}
                {!schemaLoading && !schemaError && schemaView === 'tables' && (
                  filteredTables.length > 0 ? (
                    <div className="schema-table-list">
                      {filteredTables.map((table: TableInfo) => (
                        <details className="schema-table-item" key={table.name}>
                          <summary><Table2 size={15} aria-hidden="true" /><span>{table.name}</span><small>{table.columns.length} field{table.columns.length === 1 ? '' : 's'}</small></summary>
                          <div className="schema-columns">
                            {table.columns.map((column) => <div className="schema-column" key={column.name}><span>{column.name}</span><code>{column.type || 'unknown'}</code></div>)}
                          </div>
                        </details>
                      ))}
                    </div>
                  ) : <p className="schema-state">{schema ? 'No tables match this search.' : 'No tables are available.'}</p>
                )}
                {!schemaLoading && !schemaError && schemaView === 'sources' && (
                  querySources.length > 0 ? (
                    <div className="schema-table-list">
                      {sourceTables.map(({ source, table }) => (
                        <div className="schema-source-item" key={source}>
                          <div className="schema-source-name"><Code2 size={15} aria-hidden="true" /><strong>{source}</strong></div>
                          <span>{table ? `${table.columns.length} field${table.columns.length === 1 ? '' : 's'} in the connected schema` : 'Not present in the loaded schema'}</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="schema-state">This query does not reference a table directly.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="inspector-footer">
        {tab === 'results' && (
          <>
            <button type="button" className="inspector-footer-action" onClick={() => void copy(serializeTsv(visibleResult), 'result')} disabled={visibleRows.length === 0}>
              <Clipboard size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="inspector-footer-action" onClick={download} disabled={visibleRows.length === 0} aria-label="Export CSV">
              <Download size={16} aria-hidden="true" /> Export visible rows
            </button>
          </>
        )}
        {tab === 'query' && (
          <>
            <button type="button" className="inspector-footer-action" onClick={() => void copy(artifact.query, 'query')}><Clipboard size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy query'}</button>
            <span className="inspector-footer-note">Read-only</span>
          </>
        )}
      </div>
    </aside>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled,
  busy,
  canSend
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  disabled: boolean;
  busy: boolean;
  canSend: boolean;
}) {
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <form className="composer-dock" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="composer-inner">
        <div className="composer-content">
          <textarea value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={keyDown} rows={1} disabled={disabled} placeholder={disabled ? 'Add a connection to begin' : busy ? 'DB Chat is working…' : 'Ask a question about your data'} aria-label="Question" />
          <div className="composer-meta">
            {disabled && <span>A tested connection is required</span>}
            {!disabled && <span>Enter to send · Shift + Enter for a new line</span>}
          </div>
        </div>
        {busy ? (
          <button type="button" className="composer-send composer-stop" onClick={onCancel} aria-label="Stop generation" title="Stop generation"><Square size={15} fill="currentColor" /></button>
        ) : (
          <button type="submit" className="composer-send" disabled={!canSend || disabled} aria-label="Send question" title="Send question"><Send size={16} /></button>
        )}
      </div>
    </form>
  );
}

export function ChatWorkspace({
  bootstrap,
  onNavigate,
  newChatKey,
  chatId,
  onCreateChat,
  onChatChanged
}: {
  bootstrap: BootstrapState;
  onNavigate: (path: string) => void;
  newChatKey: number;
  chatId?: string;
  onCreateChat: (connectionId: string) => Promise<WebChatSession>;
  onChatChanged: (chat: WebChatSummary) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [artifacts, setArtifacts] = useState<QueryResultArtifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [workingStatus, setWorkingStatus] = useState<WorkingStatus | null>(null);
  const [error, setError] = useState('');
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [persistedChatId, setPersistedChatId] = useState<string | null>(chatId ?? null);
  const [loadingChat, setLoadingChat] = useState(Boolean(chatId));
  const [resumeTurn, setResumeTurn] = useState<ChatTurnSnapshot | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [chatSource, setChatSource] = useState<WebChatSession['source']>();
  const [sourceAvailable, setSourceAvailable] = useState(true);
  const [feedbackCorrections, setFeedbackCorrections] = useState<Record<string, string>>({});
  const [pendingIntent, setPendingIntent] = useState<FollowUpIntent | undefined>();
  const [pendingAttemptOf, setPendingAttemptOf] = useState<string | undefined>();
  const persistedChatIdRef = useRef<string | null>(chatId ?? null);
  persistedChatIdRef.current = persistedChatId;
  const streamRef = useRef<EventSource | null>(null);
  const turnRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  const retryRequestRef = useRef<{ content: string; connectionId: string; clientRequestId: string; userMessage: ChatMessage; assistantMessageId: string; messages: ChatMessage[]; intent?: FollowUpIntent; attemptOf?: string } | null>(null);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const workingStatusClearRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const suppressAutoScrollRef = useRef(false);
  const inspectorOpenerRef = useRef<HTMLButtonElement | null>(null);
  const lastConnectionRef = useRef<string | undefined>(bootstrap.activeConnectionId);
  const active = bootstrap.connections.find((connection) => connection.id === bootstrap.activeConnectionId);
  const busy = activeTurnId !== null;

  const detachTurn = (abortServer = false) => {
    generationRef.current += 1;
    if (abortServer) retryRequestRef.current = null;
    const turnId = turnRef.current;
    turnRef.current = null;
    startingRef.current = false;
    if (turnId && abortServer) void api('/api/v1/chat/turns/' + encodeURIComponent(turnId) + '/abort', { method: 'POST' }).catch(() => undefined);
    streamRef.current?.close();
    streamRef.current = null;
    setActiveTurnId(null);
  };

  useEffect(() => {
    if (lastConnectionRef.current && lastConnectionRef.current !== bootstrap.activeConnectionId) {
      detachTurn(true);
      setMessages([]);
      setArtifacts([]);
      setSelectedArtifactId(null);
      setInspectorOpen(false);
      setDraft('');
      setError('');
      setPersistedChatId(null);
    }
    lastConnectionRef.current = bootstrap.activeConnectionId;
  }, [bootstrap.activeConnectionId]);

  useEffect(() => {
    if (newChatKey === 0) return;
    detachTurn(true);
    setMessages([]);
    setArtifacts([]);
    setSelectedArtifactId(null);
    setDraft('');
    setStatus('');
    setWorkingStatus(null);
    setError('');
    setActiveTurnId(null);
    setInspectorOpen(false);
    setPersistedChatId(null);
  }, [newChatKey]);

  useEffect(() => {
    if (!chatId) {
      setLoadingChat(false);
      setPersistedChatId(null);
      return;
    }
    if (chatId === persistedChatIdRef.current && (turnRef.current || startingRef.current)) return;
    let cancelled = false;
    detachTurn();
    setLoadingChat(true);
    setMessages([]);
    setArtifacts([]);
    setSelectedArtifactId(null);
    setDraft('');
    setStatus('');
    setWorkingStatus(null);
    setError('');
    setInspectorOpen(false);
    void api<{ chat: WebChatSession }>('/api/v1/chats/' + encodeURIComponent(chatId) + '?limit=50')
      .then(({ chat }) => {
        if (cancelled) return;
        setPersistedChatId(chat.id);
        setChatSource(chat.source);
        setSourceAvailable(chat.sourceAvailable !== false);
        setMessages(chat.messages);
        setHistoryHasMore(Boolean(chat.historyHasMore));
        setHistoryCursor(chat.historyCursor);
        const lastAnswerId = [...chat.messages].reverse().find((message) => message.role === 'assistant')?.id;
        setArtifacts(chat.artifacts.map((artifact) => ({ ...artifact, messageId: artifact.messageId ?? lastAnswerId })));
        setSelectedArtifactId(chat.artifacts[chat.artifacts.length - 1]?.queryId ?? null);
        setInspectorOpen(chat.artifacts.length > 0 && canAutoOpenInspector());
        if (chat.latestTurn && (chat.latestTurn.status === 'queued' || chat.latestTurn.status === 'running')) setResumeTurn(chat.latestTurn);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'The chat could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoadingChat(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);


  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    if (followingRef.current) endRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' });
    else setShowJumpLatest(true);
  }, [messages, artifacts, status]);

  useEffect(() => () => {
    detachTurn(false);
    if (workingStatusClearRef.current !== null) window.clearTimeout(workingStatusClearRef.current);
  }, []);

  useEffect(() => {
    const choose = (event: Event) => { const value = (event as CustomEvent<string>).detail; if (value) { setDraft(value); document.querySelector<HTMLTextAreaElement>('[aria-label="Question"]')?.focus(); } };
    window.addEventListener('dbchat:clarification', choose);
    return () => window.removeEventListener('dbchat:clarification', choose);
  }, []);

  const updateAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === assistantIdRef.current);
      if (index < 0) return current;
      return [...current.slice(0, index), updater(current[index]), ...current.slice(index + 1)];
    });
  };

  const refreshDurableChat = () => {
    const durableChatId = persistedChatIdRef.current;
    if (!durableChatId) return;
    const generation = generationRef.current;
    void api<{ chat: WebChatSession }>('/api/v1/chats/' + encodeURIComponent(durableChatId) + '?limit=50').then(({ chat }) => {
      onChatChanged(chat);
      if (generation !== generationRef.current || turnRef.current || startingRef.current) return;
      setMessages(chat.messages);
      setArtifacts(chat.artifacts);
    }).catch(() => setError('The answer finished, but saved history could not be refreshed. Reopen this chat to retrieve it.'));
  };

  const handleStreamEvent = (type: string, event: Event) => {
    const messageEvent = event as MessageEvent<string>;
    if (!messageEvent.data) return;
    let data: StreamData;
    try {
      data = JSON.parse(messageEvent.data) as StreamData;
    } catch {
      return;
    }
    if (type === 'status' || type === 'tool-start' || type === 'tool-progress' || type === 'tool-complete') {
      setReconnecting(false);
      const activity = streamActivityText(type, data);
      setStatus(activity);
      setWorkingStatus({ text: activity, complete: type === 'tool-complete' });
    } else if (type === 'text-delta') {
      updateAssistant((message) => ({ ...message, content: message.content + (data.delta ?? '') }));
    } else if (type === 'result' && data.artifact) {
      setArtifacts((current) => current.some((item) => item.queryId === data.artifact?.queryId) ? current : [...current, { ...data.artifact!, messageId: assistantIdRef.current ?? undefined }]);
      setSelectedArtifactId(data.artifact.queryId);
      setStatus('Result ready');
      setWorkingStatus({ text: 'Result ready', complete: true });
      setInspectorOpen(canAutoOpenInspector());
    } else if (type === 'complete') {
      refreshDurableChat();
      if (data.message && typeof data.message !== 'string') updateAssistant((current) => ({ ...(data.message as ChatMessage), id: current.id }));
      if (data.artifacts) {
        setArtifacts((current) => {
          const incoming = data.artifacts!.map((artifact) => ({ ...artifact, messageId: assistantIdRef.current ?? undefined }));
          return [...current.filter((item) => !incoming.some((artifact) => artifact.queryId === item.queryId)), ...incoming];
        });
        if (data.artifacts.length) {
          setSelectedArtifactId(data.artifacts[data.artifacts.length - 1].queryId);
          setInspectorOpen(canAutoOpenInspector());
        }
      }
      setStatus('');
      setWorkingStatus((current) => current ? { ...current, complete: true } : { text: 'Answer ready', complete: true });
      if (workingStatusClearRef.current !== null) window.clearTimeout(workingStatusClearRef.current);
      workingStatusClearRef.current = window.setTimeout(() => {
        setWorkingStatus(null);
        workingStatusClearRef.current = null;
      }, 650);
      turnRef.current = null;
      setActiveTurnId(null);
      setReconnecting(false);
      streamRef.current?.close();
      streamRef.current = null;
    } else if (type === 'error') {
      refreshDurableChat();
      updateAssistant((message) => ({ ...message, content: message.content || 'The answer was interrupted before any text was returned.' }));
      setError(data.messageText ?? (typeof data.message === 'string' ? data.message : data.message?.content) ?? 'The answer could not be generated.');
      setStatus('');
      setWorkingStatus(null);
      turnRef.current = null;
      setActiveTurnId(null);
      setReconnecting(false);
      streamRef.current?.close();
    } else if (type === 'aborted') {
      refreshDurableChat();
      setStatus('Question cancelled. Your previous answers and results are preserved.');
      setWorkingStatus(null);
      turnRef.current = null;
      setActiveTurnId(null);
      setReconnecting(false);
      streamRef.current?.close();
    }
  };

  const connectTurnStream = (turnId: string, resuming = false) => {
    streamRef.current?.close();
    turnRef.current = turnId;
    setActiveTurnId(turnId);
    const stream = new EventSource('/api/v1/chat/turns/' + encodeURIComponent(turnId) + '/events');
    streamRef.current = stream;
    let interrupted = false;
    stream.onopen = () => { setReconnecting(false); if (resuming || interrupted) setStatus(resuming ? 'Active answer restored.' : 'Connected. Resuming this answer…'); };
    for (const type of streamEventTypes) stream.addEventListener(type, (event) => { if (streamRef.current === stream) handleStreamEvent(type, event); });
    stream.onerror = () => {
      if (turnRef.current !== turnId) return;
      interrupted = true;
      setReconnecting(true);
      setStatus('Connection interrupted. Reconnecting…');
      setWorkingStatus({ text: 'Connection interrupted. Reconnecting…', complete: false });
      if (stream.readyState === EventSource.CLOSED) {
        void api<ChatTurnSnapshot>('/api/v1/chat/turns/' + encodeURIComponent(turnId)).then((snapshot) => {
          if (snapshot.status === 'complete' || snapshot.status === 'error' || snapshot.status === 'aborted') refreshDurableChat();
          if (snapshot.status === 'error') setError(snapshot.error ?? 'The answer was interrupted.');
          if (snapshot.status !== 'queued' && snapshot.status !== 'running') {
            turnRef.current = null; setActiveTurnId(null); setReconnecting(false); setWorkingStatus(null);
          }
        }).catch(() => setError('The event stream disconnected. Reopen this chat to recover the saved answer.'));
      }
    };
  };

  useEffect(() => {
    if (!resumeTurn || turnRef.current) return;
    assistantIdRef.current = resumeTurn.assistantMessageId ?? null;
    if (assistantIdRef.current && !messages.some((message) => message.id === assistantIdRef.current)) {
      setMessages((current) => [...current, { id: assistantIdRef.current!, role: 'assistant', content: '', createdAt: resumeTurn.createdAt ?? new Date().toISOString() }]);
    }
    setWorkingStatus({ text: 'Recovering active work…', complete: false });
    connectTurnStream(resumeTurn.id, true);
    setResumeTurn(null);
  }, [resumeTurn]);

  const submit = async (options?: { question?: string; intent?: FollowUpIntent; attemptOf?: string }) => {
    const content = (options?.question ?? draft).trim();
    const intent = options?.intent ?? pendingIntent;
    const attemptOf = options?.attemptOf ?? pendingAttemptOf;
    if (!content || busy || startingRef.current || !active || active.status !== 'ready') return;
    if (content.length > bootstrap.limits.maxMessageChars) {
      setError('Shorten your question to ' + bootstrap.limits.maxMessageChars + ' characters or fewer.');
      return;
    }
    startingRef.current = true;
    const generation = generationRef.current;
    setActiveTurnId('starting');
    if (workingStatusClearRef.current !== null) {
      window.clearTimeout(workingStatusClearRef.current);
      workingStatusClearRef.current = null;
    }
    setError('');
    setStatus('Starting');
    setWorkingStatus({ text: 'Starting', complete: false });
    const previousAttempt = retryRequestRef.current;
    const retry = previousAttempt?.content === content
      && previousAttempt.connectionId === active.id
      && previousAttempt.attemptOf === attemptOf
      && JSON.stringify(previousAttempt.intent) === JSON.stringify(intent)
      ? previousAttempt
      : null;
    const userMessage: ChatMessage = retry?.userMessage ?? {
      id: 'user-' + crypto.randomUUID(), role: 'user', content, createdAt: new Date().toISOString()
    };
    const nextMessages = retry?.messages ?? [...messages, userMessage];
    assistantIdRef.current = retry?.assistantMessageId ?? 'assistant-' + crypto.randomUUID();
    const attempt = retry ?? { content, connectionId: active.id, clientRequestId: crypto.randomUUID(), userMessage, assistantMessageId: assistantIdRef.current, messages: nextMessages, intent, attemptOf };
    retryRequestRef.current = attempt;
    setMessages([...nextMessages, {
      id: assistantIdRef.current,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }]);
    setDraft('');
    try {
      let chatIdForTurn = persistedChatId;
      if (!chatIdForTurn) {
        const chat = await onCreateChat(active.id);
        if (generation !== generationRef.current) return;
        chatIdForTurn = chat.id;
        setPersistedChatId(chat.id);
        persistedChatIdRef.current = chat.id;
        onChatChanged(chat);
        onNavigate('/chat/' + encodeURIComponent(chat.id));
      }
      const response = await api<{ turnId: string }>('/api/v1/chat/turns', {
        method: 'POST',
        body: JSON.stringify({ chatId: chatIdForTurn, assistantMessageId: attempt.assistantMessageId, userMessageId: userMessage.id, clientRequestId: attempt.clientRequestId, connectionId: active.id, question: content, intent, attemptOf, messages: modelMessages(nextMessages, bootstrap.limits.maxHistoryMessages, bootstrap.limits.maxMessageChars) })
      });
      if (generation !== generationRef.current) {
        return;
      }
      retryRequestRef.current = null;
      setPendingIntent(undefined);
      setPendingAttemptOf(undefined);
      startingRef.current = false;
      connectTurnStream(response.turnId);
    } catch (reason) {
      if (generation !== generationRef.current) return;
      startingRef.current = false;
      setActiveTurnId(null);
      setDraft(content);
      setMessages(nextMessages);
      setStatus('');
      setWorkingStatus(null);
      setError(reason instanceof Error ? reason.message : 'The question could not be started.');
    }
  };

  const followUp = (message: ChatMessage, artifact: QueryResultArtifact | undefined, action: FollowUpIntent['action'], label: string) => {
    const question = action === 'explain' ? 'Explain this result in simpler terms.'
      : action === 'compare' ? 'Compare the most important values in this result.'
        : action === 'filter' ? 'Help me narrow this result.'
          : action === 'inspect-exceptions' ? 'Inspect the exceptions in this result.'
            : 'Change how this result is displayed.';
    const intent = artifact ? { action, artifactId: artifact.queryId, messageId: message.id, text: question } satisfies FollowUpIntent : undefined;
    if (action === 'filter') {
      setDraft('Filter this result to '); setPendingIntent(intent); setPendingAttemptOf(undefined); setStatus('Describe the filter to apply to this saved result.');
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Question"]')?.focus(), 0);
      return;
    }
    setStatus(`Starting ${label.toLowerCase()} for this saved result.`);
    if (artifact && intent) void submit({ question, intent });
  };

  const updateFeedback = async (message: ChatMessage, rating: 'helpful' | 'unhelpful', correction?: string) => {
    const chat = persistedChatIdRef.current;
    if (!chat) return;
    try {
      const payload = await api<{ chat: WebChatSession }>(`/api/v1/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(message.id)}/feedback`, { method: 'POST', body: JSON.stringify({ rating, correction: correction?.trim() || undefined }) });
      const updated = payload.chat.messages.find((item) => item.id === message.id);
      if (updated) setMessages((current) => current.map((item) => item.id === updated.id ? updated : item));
      onChatChanged(payload.chat); setStatus('Feedback saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Feedback could not be saved.'); }
  };

  const pinMessage = async (message: ChatMessage) => {
    const chat = persistedChatIdRef.current; if (!chat) return;
    try { const payload = await api<{ chat: WebChatSession }>(`/api/v1/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(message.id)}`, { method: 'PATCH', body: JSON.stringify({ pinned: !message.pinned }) }); const updated = payload.chat.messages.find((item) => item.id === message.id); if (updated) setMessages((current) => current.map((item) => item.id === updated.id ? updated : item)); onChatChanged(payload.chat); setStatus(message.pinned ? 'Answer removed from saved items.' : 'Answer saved for reuse.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The answer could not be saved.'); }
  };

  const exportReport = async (format: 'html' | 'markdown', onlyMessage?: ChatMessage) => {
    const report = await import('./reportExport.js');
    const selectedMessages = onlyMessage ? messages.filter((message) => message.id === onlyMessage.id || (message.role === 'user' && messages.indexOf(message) === messages.indexOf(onlyMessage) - 1)) : messages;
    const selectedArtifacts = onlyMessage ? artifacts.filter((artifact) => artifact.messageId === onlyMessage.id) : artifacts;
    const title = (chatSource?.label ?? active?.label ?? 'DB Chat analysis') + (historyHasMore && !onlyMessage ? ' (loaded messages)' : '');
    const chartRoot = onlyMessage ? document.querySelector(`[data-message-id="${CSS.escape(onlyMessage.id)}"]`) : document.querySelector('.conversation-list');
    const contents = report.buildAnswerReport({ title, messages: selectedMessages, artifacts: selectedArtifacts, format, charts: format === 'html' && chartRoot ? report.collectReportCharts(chartRoot) : undefined });
    downloadText(contents, `db-chat-${onlyMessage ? onlyMessage.id : persistedChatIdRef.current ?? 'analysis'}.${format === 'html' ? 'html' : 'md'}`, format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8');
    setStatus(`${format === 'html' ? 'Printable HTML' : 'Markdown'} report downloaded.`);
  };

  const loadOlder = async () => {
    const chat = persistedChatIdRef.current;
    if (!chat || !historyHasMore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const payload = await api<{ chat: WebChatSession }>(`/api/v1/chats/${encodeURIComponent(chat)}?before=${encodeURIComponent(historyCursor ?? '')}&limit=40`);
      suppressAutoScrollRef.current = true;
      setMessages((current) => [...payload.chat.messages, ...current.filter((message) => !payload.chat.messages.some((older) => older.id === message.id))]);
      setArtifacts((current) => [...payload.chat.artifacts, ...current.filter((artifact) => !payload.chat.artifacts.some((older) => older.queryId === artifact.queryId))]);
      setHistoryHasMore(Boolean(payload.chat.historyHasMore)); setHistoryCursor(payload.chat.historyCursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Older messages could not be loaded.'); }
    finally { setLoadingOlder(false); }
  };

  const cancel = () => {
    const turnId = turnRef.current;
    if (!turnId) {
      detachTurn();
      updateAssistant((message) => ({ ...message, content: message.content || 'Question cancelled.' }));
      setStatus('Question cancelled.');
      setWorkingStatus(null);
      return;
    }
    // Keep listening until the server has stopped execution and saved its terminal state.
    setStatus('Stopping the question…');
    setWorkingStatus({ text: 'Stopping the question…', complete: false });
    void api('/api/v1/chat/turns/' + encodeURIComponent(turnId) + '/abort', { method: 'POST' }).catch(() => {
      setError('Cancellation could not be requested. Try Stop again or reopen this chat to check its status.');
    });
  };

  const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant');
  const currentArtifact = artifacts.find((artifact) => artifact.queryId === selectedArtifactId) ?? artifacts[artifacts.length - 1];

  return (
    <div
      className={'workspace-shell' + (inspectorOpen && currentArtifact ? ' inspector-open' : '')}
      style={inspectorOpen && currentArtifact ? ({ '--web-inspector-width': `${inspectorWidth}px` } as CSSProperties) : undefined}
    >
      <section className="workspace-conversation" aria-label="Chat workspace">
        <div ref={scrollRef} className="workspace-scroll" onScroll={(event) => {
          const node = event.currentTarget;
          followingRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
          if (followingRef.current) setShowJumpLatest(false);
        }}>
          {loadingChat ? (
            <div className="chat-loading" role="status"><LoaderCircle className="spin" size={17} /> Loading chat…</div>
          ) : messages.length === 0 && !bootstrap.connections.length ? (
            <NoConnectionState onNavigate={onNavigate} />
          ) : messages.length === 0 && !active ? (
            <NoConnectionState onNavigate={onNavigate} />
          ) : messages.length === 0 && active?.status !== 'ready' ? (
            <ConnectionAttention connection={active!} onNavigate={onNavigate} />
          ) : messages.length === 0 ? (
            <EntryStage bootstrap={bootstrap} onPrompt={setDraft} />
          ) : null}
          {messages.length > 0 && (
            <div className="conversation-stage">
              {!sourceAvailable && <div className="source-unavailable" role="status"><WifiOff size={16} aria-hidden="true" /><span><strong>{chatSource?.label ?? 'Original source'} is no longer available.</strong> Saved answers and bounded results remain readable; new queries are disabled.</span></div>}
              {historyHasMore && <button type="button" className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}
              <div className="conversation-header">
                <div>
                  <p className="overline">Research note</p>
                  <h1>{chatSource?.label ?? active?.label ?? 'Saved analysis'}</h1>
                </div>
                <span className="conversation-count">{messages.filter((message) => message.role === 'user').length} {messages.filter((message) => message.role === 'user').length === 1 ? 'question' : 'questions'}</span>
                <div className="conversation-export"><button type="button" onClick={() => void exportReport('html')}><Download size={14} /> Printable report</button><button type="button" onClick={() => void exportReport('markdown')}>Markdown</button></div>
              </div>
              <div className="conversation-list">
                {messages.map((message, index) => {
                  const messageArtifacts = artifacts.filter((artifact) => artifact.messageId === message.id || (!artifact.messageId && index === lastAssistant));
                  const recoverableTurn = message.turn && (message.turn.status === 'aborted' || message.turn.status === 'error') ? message.turn : undefined;
                  const turnQuestion = recoverableTurn?.question || [...messages.slice(0, index)].reverse().find((candidate) => candidate.role === 'user')?.content || message.content;
                  const recoveryIntent: FollowUpIntent | undefined = recoverableTurn
                    ? recoverableTurn.intent ?? { action: 'rerun', artifactId: messageArtifacts.at(-1)?.queryId, messageId: message.id }
                    : undefined;
                  const failedWithoutResults = Boolean(recoverableTurn && messageArtifacts.length === 0);
                  return (
                  <article className={'message-row message-' + message.role} key={message.id} data-message-id={message.id}>
                    <div className="message-label">{message.role === 'user' ? 'You' : 'DB Chat'}</div>
                    <div className="message-main">
                      {message.role === 'user' ? (
                        <div>
                          <div className="question-strip">{message.content}</div>
                        </div>
                      ) : (
                        <div className="assistant-response">
                          {message.content ? <AssistantContent content={message.content} /> : <span className="stream-placeholder">Preparing an answer…</span>}
                          {index === lastAssistant && workingStatus && (
                            <div className={'activity-line' + (workingStatus.complete ? ' complete' : ' active')} aria-label="Current work status" key={`${workingStatus.text}-${workingStatus.complete}`}>
                              {workingStatus.complete ? <CircleCheck size={14} aria-hidden="true" /> : <LoaderCircle className="spin" size={14} aria-hidden="true" />}
                              <span>{workingStatus.text}</span>
                            </div>
                          )}
                          {messageArtifacts.length > 0 && (
                            <div className="result-links" aria-label="Answer results">
                              {messageArtifacts.map((artifact) => (
                                <button type="button" className="result-link" key={artifact.queryId} onClick={(event) => { inspectorOpenerRef.current = event.currentTarget; setSelectedArtifactId(artifact.queryId); setInspectorOpen(true); }} aria-expanded={inspectorOpen && currentArtifact?.queryId === artifact.queryId} aria-controls="data-inspector-panel">
                                  {resultLinkLabel(artifact)} <span className="result-link-count">· {artifact.result.rowCount} {artifact.result.rowCount === 1 ? 'row' : 'rows'}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {!busy && message.content && !failedWithoutResults && (
                            <>
                              <div className="follow-up-actions">
                                <button type="button" onClick={() => followUp(message, messageArtifacts.at(-1), 'explain', 'Explain')} disabled={!messageArtifacts.length}>Explain <ArrowRight size={14} /></button>
                                {(messageArtifacts.at(-1)?.result.rows.length ?? 0) > 1 && <button type="button" onClick={() => followUp(message, messageArtifacts.at(-1), 'filter', 'Filter')}>Filter <ArrowRight size={14} /></button>}
                                <details className="answer-more" onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.removeAttribute('open'); event.currentTarget.querySelector('summary')?.focus(); } }}><summary>More actions</summary><div role="menu">
                                  {(messageArtifacts.at(-1)?.result.rows.length ?? 0) > 1 && <button role="menuitem" type="button" onClick={() => followUp(message, messageArtifacts.at(-1), 'compare', 'Compare')}>Compare values</button>}
                                  {(messageArtifacts.at(-1)?.result.rows.length ?? 0) > 1 && <button role="menuitem" type="button" onClick={() => followUp(message, messageArtifacts.at(-1), 'inspect-exceptions', 'Inspect exceptions')}>Inspect exceptions</button>}
                                  <button role="menuitem" type="button" onClick={() => void submit({ question: 'Rerun this analysis with fresh data.', attemptOf: message.turn?.id, intent: { action: 'rerun', artifactId: messageArtifacts.at(-1)?.queryId, messageId: message.id } })} disabled={!messageArtifacts.length} title="Runs a new read-only query against the current source"><RefreshCw size={14} /> Rerun with fresh data</button>
                                </div></details>
                              </div>
                              <div className="answer-secondary-actions">
                                <button type="button" onClick={() => void pinMessage(message)} aria-pressed={Boolean(message.pinned)}><Pin size={13} /> {message.pinned ? 'Saved' : 'Save'}</button>
                                <details className="answer-export"><summary><Download size={13} /> Export</summary><div><button type="button" onClick={() => void exportReport('html', message)}>Printable HTML</button><button type="button" onClick={() => void exportReport('markdown', message)}>Markdown</button></div></details>
                                {message.metrics && <details className="answer-metrics"><summary>Run details</summary><dl><div><dt>Model</dt><dd>{message.metrics.model}</dd></div><div><dt>Duration</dt><dd>{message.metrics.totalMs !== undefined ? `${(message.metrics.totalMs / 1000).toFixed(1)}s` : '—'}</dd></div><div><dt>Queries</dt><dd>{message.metrics.queryCount}</dd></div><div><dt>Tool calls</dt><dd>{message.metrics.toolCallCount}</dd></div><div><dt>Tokens</dt><dd>{message.metrics.totalTokens?.toLocaleString() ?? '—'}</dd></div>{message.metrics.costUsd !== undefined && <div><dt>Estimated cost</dt><dd>${message.metrics.costUsd.toFixed(4)}</dd></div>}<div><dt>Outcome</dt><dd>{message.metrics.terminalReason}</dd></div></dl></details>}
                                <span className="answer-feedback" aria-label="Rate this answer"><button type="button" className={message.feedback?.rating === 'helpful' ? 'selected' : ''} onClick={() => void updateFeedback(message, 'helpful')} aria-label="Helpful answer" aria-pressed={message.feedback?.rating === 'helpful'}><ThumbsUp size={14} /></button><button type="button" className={message.feedback?.rating === 'unhelpful' ? 'selected' : ''} onClick={() => setFeedbackCorrections((current) => ({ ...current, [message.id]: current[message.id] ?? message.feedback?.correction ?? '' }))} aria-label="Unhelpful answer" aria-pressed={message.feedback?.rating === 'unhelpful'}><ThumbsDown size={14} /></button></span>
                              </div>
                            </>
                          )}
                          {Object.prototype.hasOwnProperty.call(feedbackCorrections, message.id) && <div className="feedback-correction"><label htmlFor={`feedback-${message.id}`}>What should this answer have said? <span>Optional</span></label><textarea id={`feedback-${message.id}`} value={feedbackCorrections[message.id]} onChange={(event) => setFeedbackCorrections((current) => ({ ...current, [message.id]: event.target.value }))} /><div><button type="button" onClick={() => setFeedbackCorrections((current) => { const next = { ...current }; delete next[message.id]; return next; })}>Cancel</button><button type="button" onClick={() => { void updateFeedback(message, 'unhelpful', feedbackCorrections[message.id]); setFeedbackCorrections((current) => { const next = { ...current }; delete next[message.id]; return next; }); }}>Save feedback</button></div></div>}
                        </div>
                      )}
                      {recoverableTurn && (
                        <div className="turn-recovery" role="group" aria-label={`${recoverableTurn.status === 'aborted' ? 'Cancelled' : 'Failed'} question recovery`}>
                          <span>{recoverableTurn.status === 'aborted' ? 'Cancelled' : 'Could not complete'}</span>
                          <button type="button" onClick={() => void submit({ question: turnQuestion, attemptOf: recoverableTurn.id, intent: recoveryIntent })}><RefreshCw size={14} aria-hidden="true" /> Retry</button>
                          <button type="button" onClick={() => { setDraft(turnQuestion); setPendingAttemptOf(recoverableTurn.id); setPendingIntent(recoveryIntent); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Question"]')?.focus(), 0); }}><Pencil size={14} aria-hidden="true" /> Edit question</button>
                        </div>
                      )}
                    </div>
                    <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </article>
                );})}
                <div ref={endRef} />
              </div>
            </div>
          )}
          {error && <div className="workspace-error"><Alert title="We could not complete that question" onDismiss={() => setError('')}>{error}</Alert></div>}
          {showJumpLatest && <button type="button" className="jump-latest" onClick={() => { followingRef.current = true; setShowJumpLatest(false); endRef.current?.scrollIntoView({ behavior: 'smooth' }); }}>Jump to latest <ArrowRight size={14} /></button>}
        </div>
        {active?.status === 'ready' && sourceAvailable && (
          <Composer value={draft} onChange={setDraft} onSubmit={() => void submit()} onCancel={() => void cancel()} disabled={false} busy={busy} canSend={Boolean(draft.trim())} />
        )}
      </section>
      {inspectorOpen && currentArtifact && (
        <DataInspector
          artifact={currentArtifact}
          connectionLabel={currentArtifact.source?.label ?? chatSource?.label ?? active?.label ?? 'Original source'}
          connectionId={currentArtifact.source?.connectionId ?? chatSource?.connectionId ?? active?.id ?? ''}
          onClose={() => { setInspectorOpen(false); window.setTimeout(() => inspectorOpenerRef.current?.focus(), 0); }}
          inspectorWidth={inspectorWidth}
          onInspectorWidthChange={setInspectorWidth}
        />
      )}
      <div className="live-region" aria-live="polite" aria-atomic="true">{reconnecting ? 'Connection interrupted. Reconnecting to the active answer.' : status}</div>
    </div>
  );
}

function SettingsLayout({
  view,
  onNavigate,
  children,
  formLayout = false
}: {
  view: SettingsView;
  onNavigate: (path: string) => void;
  children: React.ReactNode;
  formLayout?: boolean;
}) {
  const contentRef = useRef<HTMLElement>(null);
  const previousViewRef = useRef(view);
  const items: Array<{ id: SettingsView; label: string; detail: string; path: string }> = [
    { id: 'profile', label: 'Profile and security', detail: 'Identity and access', path: '/settings' },
    { id: 'connections', label: 'Database connections', detail: 'Connections', path: '/settings/connections' },
    { id: 'inference', label: 'Inference', detail: 'Provider and model', path: '/settings/inference' }
  ];
  useEffect(() => {
    const content = contentRef.current;
    content?.scrollTo({ top: 0 });
    if (previousViewRef.current !== view) {
      window.setTimeout(() => {
        const heading = content?.querySelector<HTMLElement>('h2');
        heading?.setAttribute('tabindex', '-1');
        heading?.focus();
      }, 0);
      previousViewRef.current = view;
    }
  }, [view]);
  return (
    <div className={'settings-page' + (formLayout ? ' settings-page-form' : '')}>
      <div className="settings-heading">
        <div>
          <p className="overline">Account settings</p>
          <h1>Settings</h1>
          <p>Manage your profile, connections, and inference settings.</p>
        </div>
      </div>
      <div className={'settings-layout' + (formLayout ? ' settings-layout-form' : '')}>
        <nav className="settings-nav" aria-label="Settings">
          {items.map((item) => (
            <button type="button" className={view === item.id ? 'settings-nav-item current' : 'settings-nav-item'} key={item.id} onClick={() => onNavigate(item.path)} aria-current={view === item.id ? 'page' : undefined}>
              <span className="settings-nav-copy"><span>{item.label}</span><small>{item.detail}</small></span>
              {view === item.id && <ChevronRight size={15} aria-hidden="true" />}
            </button>
          ))}
        </nav>
        <label className="settings-mobile-picker">
          <span className="field-label">Settings section</span>
          <select value={view} onChange={(event) => onNavigate(items.find((item) => item.id === event.target.value)?.path ?? '/settings')}>
            {items.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <section className="settings-content" ref={contentRef} key={view}>{children}</section>
      </div>
    </div>
  );
}

export function ProfileSecurity({
  bootstrap,
  onRefresh,
  onLogout
}: {
  bootstrap: BootstrapState;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(bootstrap.user.displayName);
  const [currentPassword, setCurrentPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmationAction, setConfirmationAction] = useState<'sessions' | 'account' | null>(null);

  useEffect(() => {
    setDisplayName(bootstrap.user.displayName);
  }, [bootstrap.user.displayName]);

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('');
    setError('');
    setPending(true);
    try {
      await api('/api/v1/settings', { method: 'PATCH', body: JSON.stringify({ displayName }) });
      await onRefresh();
      setStatus('Profile saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Profile could not be saved.');
    } finally {
      setPending(false);
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('');
    setError('');
    if (newPassword !== confirmation) {
      setError('New passwords do not match.');
      return;
    }
    setPending(true);
    try {
      await api('/api/v1/settings', {
        method: 'PATCH',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setStatus('Password updated.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Password could not be updated.');
    } finally {
      setPending(false);
    }
  };

  const revokeSessions = async () => {
    setPending(true);
    setError('');
    try {
      await api('/api/v1/settings/sessions/revoke', { method: 'POST' });
      await onLogout();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sessions could not be revoked.');
      setPending(false);
    }
  };

  const deleteAccount = async () => {
    setPending(true); setError('');
    try { await api('/api/v1/account', { method: 'DELETE', body: JSON.stringify({ password: deletePassword }) }); await onLogout(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Your account could not be deleted.'); setPending(false); }
  };

  return (
    <div className="settings-sections">
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <p className="overline">Profile</p>
            <h2>Your account identity</h2>
            <p>This name appears in your workspace.</p>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {status && <Alert tone="success">{status}</Alert>}
        <form className="settings-form" onSubmit={(event) => void saveProfile(event)}>
          <Field label="Display name" name="settings-display-name" value={displayName} onChange={setDisplayName} autoComplete="name" required />
          <label className="field">
            <span className="field-label">Email</span>
            <span className="readonly-field">{bootstrap.user.email}{bootstrap.user.emailVerified && <span className="verified-mark"><Check size={13} /> Verified</span>}</span>
            <span className="field-helper">Your email is used to sign in.</span>
          </label>
          <Button variant="primary" type="submit" disabled={pending}>Save profile</Button>
        </form>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <p className="overline">Security</p>
            <h2>Change your password</h2>
            <p>Choose a new password to keep your account secure.</p>
          </div>
          <LockKeyhole size={20} className="section-icon" aria-hidden="true" />
        </div>
        <form className="settings-form" onSubmit={(event) => void changePassword(event)}>
          <SecretField label="Current password" name="current-password" value={currentPassword} onChange={setCurrentPassword} show={showCurrentPassword} onToggle={() => setShowCurrentPassword((shown) => !shown)} autoComplete="current-password" required />
          <SecretField label="New password" name="new-password" value={newPassword} onChange={setNewPassword} show={showNewPassword} onToggle={() => setShowNewPassword((shown) => !shown)} autoComplete="new-password" helper="At least 8 characters." required />
          <Field label="Confirm new password" name="confirm-new-password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" required />
          <Button variant="secondary" type="submit" disabled={pending}>Update password</Button>
        </form>
      </section>
      <section className="settings-section security-session">
        <div className="section-heading">
          <div>
            <p className="overline">Active session</p>
            <h2>This browser</h2>
            <p>You are currently signed in on this browser.</p>
          </div>
          <StatusLine status="healthy" label="Active" />
        </div>
        <Button variant="quiet" onClick={() => { setError(''); setConfirmationAction('sessions'); }} disabled={pending}>Log out all sessions</Button>
      </section>
      <section className="settings-section">
        <div className="section-heading"><div><h2>Delete account</h2><p>Permanently remove your account, saved chats, results, and connection details. Your source databases remain intact.</p></div></div>
        <Field label="Confirm account password" name="delete-account-password" type="password" value={deletePassword} onChange={setDeletePassword} autoComplete="current-password" />
        <Button variant="destructive" onClick={() => { setError(''); setConfirmationAction('account'); }} disabled={pending || !deletePassword}>Delete account</Button>
      </section>
      <ConfirmDialog open={confirmationAction === 'sessions'} title="Log out all sessions?" confirmLabel="Log out all sessions" pending={pending} onCancel={() => setConfirmationAction(null)} onConfirm={() => void revokeSessions()}>
        You will be signed out here and anywhere else your DB Chat account is active.
        {error && <p role="alert" className="confirm-dialog-error">{error}</p>}
      </ConfirmDialog>
      <ConfirmDialog open={confirmationAction === 'account'} title="Delete your account?" confirmLabel="Delete account" pending={pending} onCancel={() => setConfirmationAction(null)} onConfirm={() => void deleteAccount()}>
        Your account, saved chats, results, and connection details will be permanently removed. Your source databases will remain intact.
        {error && <p role="alert" className="confirm-dialog-error">{error}</p>}
      </ConfirmDialog>
    </div>
  );
}

function ConnectionRow({
  connection,
  active,
  onNavigate
}: {
  connection: WebConnection;
  active: boolean;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className={'connection-row' + (active ? ' connection-active' : '')}>
      <div className="connection-row-mark" aria-hidden="true"><Database size={18} /></div>
      <div className="connection-row-summary">
        <div className="connection-row-main">
          <div className="connection-row-title"><strong>{connection.label}</strong>{active && <span className="active-label">Active</span>}</div>
          <span className="connection-row-meta">{connection.kind === 'sqlite' ? 'Uploaded SQLite file' : formatKind(connection.kind) + (connection.safeHost ? ' · ' + connection.safeHost : '')}</span>
        </div>
        <div className="connection-row-health">
          <StatusLine status={connection.status} label={connectionStatusLabel(connection.status)} />
          <span className="connection-row-meta">{connection.lastTestedAt ? 'Tested ' + formatDate(connection.lastTestedAt) : 'Not tested yet'}</span>
          <span className="readonly-mini"><ShieldCheck size={12} /> Read-only</span>
        </div>
      </div>
      <div className="connection-row-actions">
        <button type="button" className="quiet-action" onClick={() => onNavigate('/settings/connections/' + connection.id)}>Manage <ChevronRight size={14} /></button>
      </div>
    </div>
  );
}

function ConnectionsPage({
  bootstrap,
  onNavigate
}: {
  bootstrap: BootstrapState;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="settings-sections">
      <section className="settings-section connections-section">
        <div className="section-heading section-heading-row">
          <div>
            <p className="overline">Connections</p>
            <h2>Database connections</h2>
            <p>Add, test, and manage database connections.</p>
          </div>
          <Button variant="primary" onClick={() => onNavigate('/settings/connections/new')}><Plus size={16} /> Add connection</Button>
        </div>
        {bootstrap.connections.length === 0 ? (
          <div className="settings-empty">
            <div className="empty-emblem"><Database size={19} /></div>
            <strong>No connections yet.</strong>
            <p>Add a connection before asking a question.</p>
            <Button variant="secondary" onClick={() => onNavigate('/settings/connections/new')}>Add your first connection <ArrowRight size={15} /></Button>
          </div>
        ) : (
          <div className="connection-list">
            {bootstrap.connections.map((connection) => (
              <ConnectionRow connection={connection} active={connection.id === bootstrap.activeConnectionId} onNavigate={onNavigate} key={connection.id} />
            ))}
          </div>
        )}
      </section>
      {bootstrap.connections.length > 0 && <KnowledgeEditor connections={bootstrap.connections} initialConnectionId={bootstrap.activeConnectionId} />}
      <section className="settings-section settings-note-section">
        <div className="section-note-icon"><ShieldCheck size={17} /></div>
        <div><strong>Read-only policy</strong><p>Connections use read-only queries. Use a database role with only the permissions DB Chat needs.</p></div>
      </section>
    </div>
  );
}

function KnowledgeEditor({ connections, initialConnectionId }: { connections: WebConnection[]; initialConnectionId?: string }) {
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? connections[0].id);
  const [knowledge, setKnowledge] = useState<ConnectionKnowledge | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let cancelled = false; setLoading(true); setStatus('');
    void api<{ knowledge: ConnectionKnowledge }>(`/api/v1/connections/${encodeURIComponent(connectionId)}/knowledge`).then(({ knowledge }) => { if (!cancelled) setKnowledge(knowledge); }).catch((reason) => { if (!cancelled) setStatus(reason instanceof Error ? reason.message : 'Knowledge could not be loaded.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId]);
  const save = async () => {
    if (!knowledge) return; setSaving(true); setStatus('');
    try { const payload = await api<{ knowledge: ConnectionKnowledge }>(`/api/v1/connections/${encodeURIComponent(connectionId)}/knowledge`, { method: 'PUT', body: JSON.stringify({ knowledge }) }); setKnowledge(payload.knowledge); setStatus('Definitions and verified examples saved.'); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : 'Knowledge could not be saved.'); }
    finally { setSaving(false); }
  };
  return <section className="settings-section knowledge-editor">
    <div className="section-heading"><p className="overline">Shared context</p><h2>Definitions and verified examples</h2><p>Private knowledge for one connection. DB Chat uses only definitions you save here.</p></div>
    <label>Connection<select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
    {loading ? <p role="status">Loading saved knowledge…</p> : knowledge && <>
      <div className="knowledge-list"><h3>Glossary</h3>{knowledge.glossary.map((item, index) => <div className="knowledge-row" key={item.id}><input aria-label={`Term ${index + 1}`} value={item.term} onChange={(event) => setKnowledge({ ...knowledge, glossary: knowledge.glossary.map((entry) => entry.id === item.id ? { ...entry, term: event.target.value } : entry) })} /><textarea aria-label={`Definition for ${item.term || `term ${index + 1}`}`} value={item.definition} onChange={(event) => setKnowledge({ ...knowledge, glossary: knowledge.glossary.map((entry) => entry.id === item.id ? { ...entry, definition: event.target.value } : entry) })} /><button type="button" className="button button-quiet" onClick={() => setKnowledge({ ...knowledge, glossary: knowledge.glossary.filter((entry) => entry.id !== item.id) })}>Remove</button></div>)}<button type="button" className="button button-secondary" onClick={() => setKnowledge({ ...knowledge, glossary: [...knowledge.glossary, { id: crypto.randomUUID(), term: '', definition: '', provenance: 'user', updatedAt: new Date().toISOString() }] })}><Plus size={14} /> Add definition</button></div>
      <div className="knowledge-list"><h3>Verified question and query examples</h3>{knowledge.examples.map((item, index) => <div className="knowledge-example" key={item.id}><input aria-label={`Verified question ${index + 1}`} value={item.question} onChange={(event) => setKnowledge({ ...knowledge, examples: knowledge.examples.map((entry) => entry.id === item.id ? { ...entry, question: event.target.value } : entry) })} /><textarea aria-label={`Verified query ${index + 1}`} value={item.query} onChange={(event) => setKnowledge({ ...knowledge, examples: knowledge.examples.map((entry) => entry.id === item.id ? { ...entry, query: event.target.value } : entry) })} />{item.invalidatedAt && <><span className="knowledge-stale">Schema changed — verify this query again.</span><button type="button" className="button button-secondary" onClick={async () => { setSaving(true); try { const body = { ...knowledge, examples: knowledge.examples.map((entry) => entry.id === item.id ? { ...entry, reverify: true } : entry) }; const payload = await api<{ knowledge: ConnectionKnowledge }>(`/api/v1/connections/${encodeURIComponent(connectionId)}/knowledge`, { method: 'PUT', body: JSON.stringify({ knowledge: body }) }); setKnowledge(payload.knowledge); setStatus('Verified against the current schema.'); } finally { setSaving(false); } }}>Verify again</button></>}<button type="button" className="button button-quiet" onClick={() => setKnowledge({ ...knowledge, examples: knowledge.examples.filter((entry) => entry.id !== item.id) })}>Remove</button></div>)}<button type="button" className="button button-secondary" onClick={() => setKnowledge({ ...knowledge, examples: [...knowledge.examples, { id: crypto.randomUUID(), question: '', query: '', provenance: 'user', verifiedAt: new Date().toISOString() }] })}><Plus size={14} /> Add verified example</button></div>
      <div className="form-actions"><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save connection knowledge'}</Button><span role="status">{status}</span></div>
    </>}
  </section>;
}

export function draftForConnection(connection?: WebConnection): ConnectionDraft {
  const kind = connection?.kind ?? 'postgres';
  return {
    label: connection?.label ?? '',
    kind,
    databasePath: '',
    sqliteFileName: connection?.sqliteFileName ?? '',
    host: connection?.host ?? '',
    port: connection?.port !== undefined ? String(connection.port) : kind === 'postgres' ? '5432' : kind === 'mysql' ? '3306' : kind === 'mongodb' ? '27017' : '9200',
    database: connection?.database ?? '',
    username: connection?.username ?? '',
    password: '',
    ssl: connection?.ssl ?? true,
    mongodbUri: '',
    elasticsearchUrl: '',
    elasticsearchVerifyCerts: connection?.elasticsearchVerifyCerts ?? true
  };
}

export function ConnectionForm({
  bootstrap,
  connection,
  onNavigate,
  onRefresh
}: {
  bootstrap: BootstrapState;
  connection?: WebConnection;
  onNavigate: (path: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftForConnection(connection));
  const [pending, setPending] = useState<'save' | 'test' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showConnectionPassword, setShowConnectionPassword] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [fileDragging, setFileDragging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [savedId, setSavedId] = useState(connection?.id);
  const currentId = savedId ?? connection?.id;
  const maxSqliteUploadBytes = bootstrap.limits.maxSqliteUploadBytes ?? 50 * 1024 * 1024;
  const elasticsearchEndpoint = draft.kind === 'elasticsearch' && draft.host.trim()
    ? `${draft.ssl ? 'https' : 'http'}://${draft.host.trim().replace(/^https?:\/\//, '')}${draft.port.trim() ? ':' + draft.port.trim() : ''}`
    : '';

  useEffect(() => {
    setDraft(draftForConnection(connection));
    setSavedId(connection?.id);
  }, [connection?.id]);

  const update = (key: keyof ConnectionDraft, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const uploadFile = async (file: File) => {
    setFileDragging(false);
    setError('');
    setNotice('');
    if (!/\.(?:db|sqlite|sqlite3)$/i.test(file.name)) {
      setError('Choose a SQLite file ending in .db, .sqlite, or .sqlite3.');
      return;
    }
    if (file.size > maxSqliteUploadBytes) {
      setError(`That file is too large. SQLite uploads must be ${Math.round(maxSqliteUploadBytes / (1024 * 1024))} MB or smaller.`);
      return;
    }
    setUploadingFile(true);
    try {
      const response = await fetch('/api/v1/sqlite-files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-DBChat-Filename': encodeURIComponent(file.name)
        },
        body: file
      });
      const payload = await response.json().catch(() => ({})) as { uploadId?: string; fileName?: string; error?: string };
      if (response.status === 401) {
        window.dispatchEvent(new Event('dbchat:auth-required'));
        throw new ApiError('Your session has expired. Sign in again to continue.', response.status);
      }
      if (!response.ok || !payload.uploadId || !payload.fileName) {
        throw new ApiError(payload.error ?? 'The SQLite file could not be uploaded.', response.status);
      }
      setDraft((current) => ({
        ...current,
        databasePath: '',
        sqliteUploadId: payload.uploadId,
        sqliteFileName: payload.fileName
      }));
      setNotice(`${payload.fileName} is ready to test.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The SQLite file could not be uploaded.');
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const chooseFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.kind === 'sqlite' && !draft.sqliteUploadId && !draft.sqliteFileName) {
      setError('Choose a SQLite database file before saving the connection.');
      return;
    }
    setPending('test');
    setError('');
    setNotice('');
    try {
      const response = currentId
        ? await api<{ connection: WebConnection }>('/api/v1/connections/' + currentId, { method: 'PATCH', body: JSON.stringify(buildConnectionPayload(draft)) })
        : await api<{ connection: WebConnection }>('/api/v1/connections', { method: 'POST', body: JSON.stringify(buildConnectionPayload(draft)) });
      const id = response.connection.id;
      setSavedId(id);
      await onRefresh();
      const test = await api<{ connection: WebConnection; health: { status: string } }>('/api/v1/connections/' + id + '/test', { method: 'POST' });
      await onRefresh();
      if (test.health.status !== 'ready') throw new Error(test.connection.lastError ?? 'The connection could not be reached.');
      setNotice('Connection saved and tested.');
      onNavigate('/settings/connections/' + id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The connection could not be saved.');
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    if (!currentId) return;
    setPending('delete');
    setError('');
    try {
      await api('/api/v1/connections/' + currentId, { method: 'DELETE' });
      await onRefresh();
      onNavigate('/settings/connections');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The connection could not be removed.');
    } finally {
      setPending(null);
    }
  };

  const formPending = pending !== null || uploadingFile;

  return (
    <div className="settings-sections">
      <section className="settings-section connection-form-section">
        <div className="section-heading">
          <div>
            <p className="overline">{connection ? 'Manage connection' : 'New connection'}</p>
            <h2>{connection ? connection.label : 'Add a database connection'}</h2>
            <p>{draft.kind === 'sqlite'
              ? 'Review the uploaded SQLite file DB Chat uses for read-only questions.'
              : 'Add the database details DB Chat needs to connect with read-only access.'}</p>
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        <form className="connection-form" onSubmit={(event) => void save(event)}>
          <div className="form-subsection">
            <p className="form-subsection-title">Identity</p>
            <div className="form-grid-two">
              <Field label="Connection name" name="connection-label" value={draft.label} onChange={(value) => update('label', value)} placeholder="Analytics warehouse" required />
              <label className="field">
                <span className="field-label">Database type</span>
                <span className="select-wrap">
                  <select value={draft.kind} onChange={(event) => update('kind', event.target.value)}>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                    <option value="mongodb">MongoDB</option>
                    <option value="elasticsearch">Elasticsearch</option>
                    <option value="sqlite">SQLite file</option>
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </label>
            </div>
          </div>
          <div className="form-subsection">
            <p className="form-subsection-title">{draft.kind === 'sqlite' ? 'Uploaded file' : 'Location and credentials'}</p>
            {draft.kind === 'sqlite' ? (
              <div className="field">
                <span className="field-label">SQLite database file</span>
                <label
                  className={'sqlite-file-picker' + (fileDragging ? ' is-dragging' : '') + (draft.sqliteFileName ? ' has-file' : '')}
                  onDragEnter={(event) => { event.preventDefault(); setFileDragging(true); }}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setFileDragging(true); }}
                  onDragLeave={(event) => { event.preventDefault(); setFileDragging(false); }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setFileDragging(false);
                    const file = event.dataTransfer.files[0];
                    if (file) void uploadFile(file);
                  }}
                >
                  <input
                    ref={fileInputRef}
                    className="sqlite-file-input"
                    type="file"
                    accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3"
                    onChange={chooseFile}
                    disabled={formPending}
                    aria-label="Choose a SQLite database file"
                  />
                  <span className="sqlite-file-picker-icon" aria-hidden="true">
                    {uploadingFile ? <LoaderCircle className="spin" size={20} /> : <Upload size={20} />}
                  </span>
                  <span className="sqlite-file-picker-copy">
                    <strong>{uploadingFile ? 'Uploading file…' : draft.sqliteFileName || 'Drop a SQLite file here'}</strong>
                    <span>{uploadingFile ? 'Keep this page open while the upload finishes.' : 'or click to browse for a .db, .sqlite, or .sqlite3 file'}</span>
                  </span>
                  {draft.sqliteFileName && !uploadingFile && <Check className="sqlite-file-picker-check" size={18} aria-hidden="true" />}
                </label>
                <span className="field-helper">The file is uploaded to your DB Chat workspace before it is tested. Maximum size: {Math.round(maxSqliteUploadBytes / (1024 * 1024))} MB.</span>
                <span className="sqlite-file-status" role="status" aria-live="polite">{draft.sqliteFileName ? 'Selected file: ' + draft.sqliteFileName : 'No SQLite file selected.'}</span>
              </div>
            ) : draft.kind === 'mongodb' ? (
              <>
                <Field label="MongoDB connection URI" name="mongodb-uri" value={draft.mongodbUri} onChange={(value) => update('mongodbUri', value)} placeholder="mongodb+srv://host/database" helper="The URI is encrypted after saving and never shown again." />
                <div className="form-grid-two"><Field label="Host" name="mongo-host" value={draft.host} onChange={(value) => update('host', value)} placeholder="db.example.com" /><Field label="Port" name="mongo-port" value={draft.port} onChange={(value) => update('port', value)} placeholder="27017" /></div>
                <Field label="Database name" name="mongo-database" value={draft.database} onChange={(value) => update('database', value)} placeholder="analytics" />
              </>
            ) : (
              <>
                <div className="form-grid-two"><Field label={draft.kind === 'elasticsearch' ? 'Host' : 'Host'} name="connection-host" value={draft.host} onChange={(value) => update('host', value)} placeholder="db.example.com" required /><Field label="Port" name="connection-port" value={draft.port} onChange={(value) => update('port', value)} placeholder="5432" /></div>
                <Field label={draft.kind === 'elasticsearch' ? 'Index or database name' : 'Database name'} name="connection-database" value={draft.database} onChange={(value) => update('database', value)} placeholder={draft.kind === 'elasticsearch' ? 'events' : 'analytics'} />
                <div className="form-grid-two"><Field label="Username" name="connection-username" value={draft.username} onChange={(value) => update('username', value)} placeholder="dbchat_readonly" autoComplete="username" /><SecretField label="Password" name="connection-password" value={draft.password} onChange={(value) => update('password', value)} show={showConnectionPassword} onToggle={() => setShowConnectionPassword((shown) => !shown)} autoComplete="new-password" helper={connection ? 'Leave blank to keep the saved credential.' : undefined} /></div>
              </>
            )}
          </div>
          {draft.kind !== 'sqlite' && <div className="form-subsection">
            <p className="form-subsection-title">Connection safety</p>
            <label className="checkbox-row checkbox-row-block">
              <input type="checkbox" checked={draft.ssl} onChange={(event) => update('ssl', event.target.checked)} />
              <span><strong>Use TLS / SSL</strong><small>Recommended for hosted connections and protects credentials in transit.</small></span>
            </label>
            {draft.kind === 'elasticsearch' && elasticsearchEndpoint && <div className="endpoint-preview" aria-live="polite"><span>Connection URL</span><code>{elasticsearchEndpoint}</code></div>}
            {draft.kind === 'elasticsearch' && <label className="checkbox-row checkbox-row-block"><input type="checkbox" checked={draft.elasticsearchVerifyCerts} onChange={(event) => update('elasticsearchVerifyCerts', event.target.checked)} disabled={!draft.ssl} /><span><strong>Verify the server certificate</strong><small>Turn this off only for a controlled test environment.</small></span></label>}
            <p className="form-note"><ShieldCheck size={16} aria-hidden="true" /> Use a database account with read-only permissions. DB Chat runs only schema inspection, sampling, and bounded read queries.</p>
          </div>}
          {draft.kind === 'sqlite' && <div className="form-subsection sqlite-file-details">
            <p className="form-subsection-title">How this file is used</p>
            <div className="safety-callout"><ShieldCheck size={17} /><div><strong>Read-only access</strong><p>DB Chat stores this uploaded copy in your workspace and uses it for schema inspection and bounded read-only queries. Replacing it updates this connection after you save and test.</p></div></div>
          </div>}
          <div className="form-actions">
            <Button variant="primary" type="submit" disabled={formPending}>{pending === 'test' ? <><LoaderCircle className="spin" size={16} /> Saving and testing</> : 'Save and test'}</Button>
            <Button variant="quiet" type="button" onClick={() => onNavigate('/settings/connections')}>Cancel</Button>
            {connection && <Button variant="destructive" type="button" className="form-delete" onClick={() => { setError(''); setConfirmRemove(true); }} disabled={formPending}><Trash2 size={15} /> Remove</Button>}
          </div>
        </form>
        <ConfirmDialog open={confirmRemove} title={`Remove ${connection?.label ?? 'this connection'}?`} confirmLabel="Remove connection" pending={pending === 'delete'} onCancel={() => setConfirmRemove(false)} onConfirm={() => void remove()}>
          {connection?.kind === 'sqlite' ? 'DB Chat will delete this connection and its uploaded copy. The original file on your device will remain unchanged.' : 'DB Chat will delete the saved connection details and credentials. Your source database will remain unchanged.'}
          {error && <p role="alert" className="confirm-dialog-error">{error}</p>}
        </ConfirmDialog>
      </section>
    </div>
  );
}

function InferencePage({
  bootstrap,
  onRefresh: _onRefresh
}: {
  bootstrap: BootstrapState;
  onRefresh: () => Promise<void>;
}) {
  const callout = getInferenceCallout(bootstrap.inference);

  return (
    <div className="settings-sections">
      <section className="settings-section">
        <div className="section-heading section-heading-row">
          <div>
            <p className="overline">AI settings</p>
            <h2>Inference</h2>
            <p>Manage how DB Chat uses AI to understand your data.</p>
          </div>
          <StatusLine status={callout.available ? 'healthy' : 'unavailable'} label={callout.available ? 'Ready' : 'Unavailable'} />
        </div>
        <div className="inference-summary">
          <div className="inference-summary-row"><span>Provider</span><strong>OpenRouter</strong></div>
          <div className="inference-summary-row"><span>Model</span><code>{bootstrap.inference.model}</code></div>
        </div>
        <details className="inference-disclosure"><summary>How your data is used</summary><p>Relevant schema context and query results are sent to the AI provider to answer your questions. DB Chat never sends your database credentials.</p></details>
      </section>
      <p className="inference-availability" role="status">{callout.available ? 'AI is ready for your questions.' : callout.description}</p>
    </div>
  );
}

function SettingsPage({
  bootstrap,
  view,
  editingConnection,
  onNavigate,
  onRefresh,
  onLogout
}: {
  bootstrap: BootstrapState;
  view: SettingsView;
  editingConnection?: WebConnection;
  onNavigate: (path: string) => void;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const isConnectionForm = Boolean(editingConnection || view === 'connections' && window.location.pathname.endsWith('/new'));
  const content = isConnectionForm
    ? <ConnectionForm bootstrap={bootstrap} connection={editingConnection} onNavigate={onNavigate} onRefresh={onRefresh} />
    : view === 'profile'
      ? <ProfileSecurity bootstrap={bootstrap} onRefresh={onRefresh} onLogout={onLogout} />
      : view === 'connections'
        ? <ConnectionsPage bootstrap={bootstrap} onNavigate={onNavigate} />
        : <InferencePage bootstrap={bootstrap} onRefresh={onRefresh} />;
  return <SettingsLayout view={view} onNavigate={onNavigate} formLayout={isConnectionForm}>{content}</SettingsLayout>;
}

function LoadingScreen() {
  return <div className="loading-screen"><span className="loading-orbit"><LoaderCircle className="spin" size={20} /></span><p>Loading your workspace…</p></div>;
}

export function App() {
  const [route, setRoute] = useState(window.location.pathname || '/');
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [newChatKey, setNewChatKey] = useState(0);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const initialChatId = window.location.pathname.match(/^\/chat\/([^/]+)$/)?.[1] ?? null;
  const [chats, setChats] = useState<WebChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId);

  const navigate = (path: string) => {
    setNavigationOpen(false);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setRoute(path);
    const chatId = path.match(/^\/chat\/([^/]+)$/)?.[1] ?? null;
    if (chatId || path === '/') setSelectedChatId(chatId);
  };

  const refreshBootstrap = async () => {
    try {
      const next = await api<BootstrapState>('/api/v1/bootstrap');
      setBootstrap(next);
      setAuthState('authenticated');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setAuthState('unauthenticated');
        setBootstrap(null);
        setChats([]);
        setSelectedChatId(null);
      }
      throw reason;
    }
  };

  const refreshChats = async () => {
    const response = await api<{ chats: WebChatSummary[] }>('/api/v1/chats');
    setChats(response.chats);
    return response.chats;
  };

  const createChat = (connectionId: string) => api<{ chat: WebChatSession }>('/api/v1/chats', {
    method: 'POST',
    body: JSON.stringify({ connectionId })
  }).then((response) => response.chat);


  const onChatChanged = useCallback((chat: WebChatSummary) => {
    setChats((current) => [chat, ...current.filter((item) => item.id !== chat.id)].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  }, []);

  useEffect(() => {
    document.title = 'DB Chat Web';
    const onPopState = () => {
      const nextRoute = window.location.pathname || '/';
      setRoute(nextRoute);
      const chatId = nextRoute.match(/^\/chat\/([^/]+)$/)?.[1] ?? null;
      if (chatId || nextRoute === '/') setSelectedChatId(chatId);
    };
    const onAuthRequired = () => {
      setBootstrap(null);
      setAuthState('unauthenticated');
      if (window.location.pathname !== '/login' && window.location.pathname !== '/signup') {
        window.history.replaceState({}, '', '/login');
        setRoute('/login');
      }
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('dbchat:auth-required', onAuthRequired);
    void (async () => {
      try {
        if (window.location.pathname === '/auth/confirm') { setAuthState('unauthenticated'); return; }
        const me = await api<{ authenticated: boolean }>('/api/v1/auth/me');
        if (!me.authenticated) {
          setAuthState('unauthenticated');
          if (window.location.pathname.startsWith('/settings') || window.location.pathname.startsWith('/chat')) {
            window.history.replaceState({}, '', '/login');
            setRoute('/login');
          }
          return;
        }
        await refreshBootstrap();
        await refreshChats();
      } catch {
        setAuthState('unauthenticated');
      }
    })();
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('dbchat:auth-required', onAuthRequired);
    };
  }, []);

  const completeAuth = async (mode: 'signup' | 'login', data: { email: string; password: string; displayName?: string }) => {
    const result = await api<{ confirmationRequired?: boolean }>('/api/v1/auth/' + mode, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (result.confirmationRequired) return result;
    await refreshBootstrap();
    await refreshChats();
    navigate('/');
  };

  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    setBootstrap(null);
    setChats([]);
    setSelectedChatId(null);
    setAuthState('unauthenticated');
    navigate('/login');
  };

  const selectConnection = async (connectionId: string, preserveRoute = false) => {
    await api('/api/v1/settings', {
      method: 'PATCH',
      body: JSON.stringify({ activeConnectionId: connectionId || null })
    });
    await refreshBootstrap();
    if (!preserveRoute && route !== '/') {
      setSelectedChatId(null);
      navigate('/');
    }
  };

  const startNewChat = () => {
    setSelectedChatId(null);
    setNewChatKey((current) => current + 1);
    navigate('/');
  };

  const renameChat = async (chat: WebChatSummary, title: string) => {
    const response = await api<{ chat: WebChatSession }>('/api/v1/chats/' + encodeURIComponent(chat.id), {
      method: 'PATCH',
      body: JSON.stringify({ title })
    });
    onChatChanged(response.chat);
  };

  const deleteChat = async (chat: WebChatSummary) => {
    await api('/api/v1/chats/' + encodeURIComponent(chat.id), { method: 'DELETE' });
    setChats((current) => current.filter((item) => item.id !== chat.id));
    if (selectedChatId === chat.id || route === '/chat/' + encodeURIComponent(chat.id)) startNewChat();
  };

  const pinChat = async (chat: WebChatSummary) => {
    const response = await api<{ chat: WebChatSession }>('/api/v1/chats/' + encodeURIComponent(chat.id), { method: 'PATCH', body: JSON.stringify({ pinned: !chat.pinned }) });
    onChatChanged(response.chat);
  };

  const selectChat = async (chat: WebChatSummary) => {
    try {
      if (chat.connectionId && chat.connectionId !== bootstrap?.activeConnectionId) {
        await selectConnection(chat.connectionId, true);
      }
      setSelectedChatId(chat.id);
      navigate('/chat/' + encodeURIComponent(chat.id));
    } catch (reason) {
      console.error(reason);
    }
  };

  if (['/forgot-password', '/auth/confirm', '/reset-password'].includes(route)) return <AccountRecoveryScreen key={route} mode={route === '/forgot-password' ? 'forgot' : route === '/auth/confirm' ? 'confirm' : 'reset'} onNavigate={navigate} onVerified={async () => { await refreshBootstrap(); await refreshChats(); }} />;
  if (authState === 'loading') return <LoadingScreen />;
  if (authState === 'unauthenticated') {
    if (route === '/signup') return <AuthScreen mode="signup" onNavigate={navigate} onComplete={(data) => completeAuth('signup', data)} />;
    if (route === '/login') return <AuthScreen mode="login" onNavigate={navigate} onComplete={(data) => completeAuth('login', data)} />;
    if (route === '/privacy') return <PublicPolicy onNavigate={navigate} />;
    return <Landing onNavigate={navigate} />;
  }
  if (!bootstrap) return <LoadingScreen />;

  const settingsPath = route.startsWith('/settings');
  const view: SettingsView = route.includes('/connections') ? 'connections' : route.includes('/inference') ? 'inference' : 'profile';
  const editingId = route.match(/^\/settings\/connections\/([^/]+)$/)?.[1];
  const editingConnection = editingId && editingId !== 'new' ? bootstrap.connections.find((connection) => connection.id === editingId) : undefined;

  return (
    <div className={'app-shell' + (navigationOpen ? ' navigation-open' : '')} onKeyDown={(event) => { if (event.key === 'Escape') { setNavigationOpen(false); document.querySelector<HTMLButtonElement>('.workspace-navigation-toggle')?.focus(); } }}>
      <AppBar bootstrap={bootstrap} onNavigate={navigate} onRefresh={refreshBootstrap} onLogout={logout} navigationOpen={navigationOpen} onToggleNavigation={() => setNavigationOpen((open) => !open)} />
      <div className="app-body">
        <WorkspaceSidebar bootstrap={bootstrap} route={route} onNavigate={navigate} onSelectConnection={(id) => { setNavigationOpen(false); return selectConnection(id); }} onNewChat={startNewChat} chats={chats} selectedChatId={selectedChatId} onSelectChat={(chat) => void selectChat(chat)} onRenameChat={renameChat} onDeleteChat={deleteChat} onPinChat={pinChat} />
        <main className="app-main">
          {settingsPath ? (
            <SettingsPage bootstrap={bootstrap} view={view} editingConnection={editingConnection} onNavigate={navigate} onRefresh={refreshBootstrap} onLogout={logout} />
          ) : (
            <ChatWorkspace
              bootstrap={bootstrap}
              onNavigate={navigate}
              newChatKey={newChatKey}
              chatId={route.match(/^\/chat\/([^/]+)$/)?.[1]}
              onCreateChat={createChat}
              onChatChanged={onChatChanged}
            />
          )}
        </main>
      </div>
    </div>
  );
}
