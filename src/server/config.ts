import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig, DatabaseKind } from '../shared/types.js';

export type WebAuthMode = 'dev' | 'app';

export const DEFAULT_WEB_MODEL = 'deepseek/deepseek-v4-flash-0731';

export interface WebServerConfig {
  storageMode?: 'local' | 'supabase';
  supabase?: { url: string; publishableKey: string; serviceRoleKey: string };
  host: string;
  port: number;
  staticDir: string;
  authMode: WebAuthMode;
  accountStorePath: string;
  secretKeyPath: string;
  allowedOrigin?: string;
  sessionTtlMs: number;
  sessionAbsoluteTtlMs: number;
  turnTimeoutMs: number;
  database?: ConnectionConfig;
  databaseLabel: string;
  openRouterApiKey?: string;
  model: string;
  maxBodyBytes: number;
  maxChatBodyBytes?: number;
  allowedDatabaseHosts?: string[];
  maxActiveTurnsPerUser?: number;
  maxActiveTurns?: number;
  maxHistoryMessages: number;
  maxMessageChars: number;
  maxResultRows: number;
  maxResultBytes: number;
  maxSqliteUploadBytes?: number;
  sqliteUploadDir?: string;
  userKeyUiEnabled?: boolean;
  secretKey?: string;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function decode(value: string | undefined): string | undefined {
  return value ? decodeURIComponent(value) : undefined;
}

function connectionFromEnv(env: NodeJS.ProcessEnv): ConnectionConfig | undefined {
  const kind = (env.DBCHAT_WEB_DATABASE_KIND ?? '').toLowerCase() as DatabaseKind;
  if (!kind) return undefined;

  const label = env.DBCHAT_WEB_DATABASE_LABEL ?? `${kind} database`;
  const createdAt = new Date().toISOString();
  const base = { id: 'web-configured', kind, label, createdAt } as const;

  if (kind === 'sqlite') {
    const databasePath = env.DBCHAT_WEB_DATABASE_PATH;
    return databasePath
      ? { ...base, databasePath: path.resolve(databasePath), safetyLevel: 'safe' }
      : undefined;
  }

  const rawUrl = env.DBCHAT_WEB_DATABASE_URL;
  const parsed = rawUrl ? new URL(rawUrl) : null;
  const host = env.DBCHAT_WEB_DATABASE_HOST ?? parsed?.hostname;
  const port = Number(env.DBCHAT_WEB_DATABASE_PORT ?? parsed?.port ?? '') || undefined;
  const database = env.DBCHAT_WEB_DATABASE_NAME ?? decode(parsed?.pathname.replace(/^\//, ''));
  const username = env.DBCHAT_WEB_DATABASE_USERNAME ?? decode(parsed?.username);
  const password = env.DBCHAT_WEB_DATABASE_PASSWORD ?? decode(parsed?.password);
  const ssl = env.DBCHAT_WEB_DATABASE_SSL === 'true' || parsed?.protocol === 'https:';

  if (kind === 'mongodb') {
    return {
      ...base,
      mongodbUri: rawUrl,
      host,
      port,
      database,
      username,
      password,
      ssl,
      safetyLevel: 'safe'
    };
  }

  if (kind === 'elasticsearch') {
    return {
      ...base,
      elasticsearchUrl: rawUrl,
      elasticsearchHost: host,
      elasticsearchPort: port,
      elasticsearchUsername: username,
      elasticsearchPassword: password,
      elasticsearchUseSsl: ssl,
      elasticsearchVerifyCerts: env.DBCHAT_WEB_DATABASE_VERIFY_CERTS !== 'false',
      safetyLevel: 'safe'
    };
  }

  if (!host) return undefined;
  return {
    ...base,
    host,
    port,
    database,
    username,
    password,
    ssl,
    safetyLevel: 'safe'
  };
}

export function loadWebServerConfig(env: NodeJS.ProcessEnv = process.env): WebServerConfig {
  const authMode = (env.DBCHAT_WEB_AUTH_MODE ?? 'app') as WebAuthMode;
  if (!['dev', 'app'].includes(authMode)) {
    throw new Error(`Unsupported DBCHAT_WEB_AUTH_MODE: ${authMode}`);
  }
  if (env.NODE_ENV === 'production' && authMode !== 'app') {
    throw new Error('DBCHAT_WEB_AUTH_MODE must be app in production.');
  }

  const supabaseUrl = env.SUPABASE_URL;
  const storageMode = env.DBCHAT_STORAGE_MODE ?? (supabaseUrl ? 'supabase' : 'local');
  if (!['local', 'supabase'].includes(storageMode)) throw new Error('Unsupported DBCHAT_STORAGE_MODE.');
  if (env.NODE_ENV === 'production' && storageMode !== 'supabase') {
    throw new Error('Production requires Supabase storage and authentication. Configure SUPABASE_URL and DBCHAT_STORAGE_MODE=supabase.');
  }
  const supabase = storageMode === 'supabase' ? {
    url: supabaseUrl ?? '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  } : undefined;
  if (supabase && (!supabase.url || !supabase.publishableKey || !supabase.serviceRoleKey
    || !env.DBCHAT_WEB_SECRET_KEY || env.DBCHAT_WEB_SECRET_KEY.length < 32 || !env.DBCHAT_WEB_ALLOWED_ORIGIN)) {
    throw new Error('Supabase mode requires URL, publishable key, service-role key, a secret encryption key of at least 32 characters, and the public app origin.');
  }
  if (supabase) {
    const address = new URL(supabase.url);
    if (address.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(address.hostname)) throw new Error('Supabase URL must use HTTPS.');
  }
  if (supabase && authMode !== 'app') throw new Error('Supabase requires app authentication.');
  if (env.DBCHAT_WEB_ALLOWED_ORIGIN) {
    const origin = new URL(env.DBCHAT_WEB_ALLOWED_ORIGIN);
    if (origin.origin !== env.DBCHAT_WEB_ALLOWED_ORIGIN || (env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw new Error('Set the public app origin to its HTTPS origin without a path.');
  }
  const dataDirectory = path.resolve(env.DBCHAT_WEB_DATA_DIR ?? path.join(os.homedir(), '.dbchat'));

  return {
    storageMode: storageMode as 'local' | 'supabase',
    supabase,
    host: env.DBCHAT_WEB_HOST ?? '127.0.0.1',
    port: numberFromEnv(env.PORT ?? env.DBCHAT_WEB_PORT, 8787),
    staticDir: path.resolve(env.DBCHAT_WEB_STATIC_DIR ?? 'dist-web'),
    authMode,
    accountStorePath: path.resolve(env.DBCHAT_WEB_ACCOUNT_STORE_PATH ?? path.join(dataDirectory, 'accounts.json')),
    secretKeyPath: path.resolve(env.DBCHAT_WEB_SECRET_KEY_FILE ?? path.join(dataDirectory, 'secret.key')),
    allowedOrigin: env.DBCHAT_WEB_ALLOWED_ORIGIN,
    sessionTtlMs: numberFromEnv(env.DBCHAT_WEB_SESSION_TTL_MS, 30 * 60 * 1000),
    sessionAbsoluteTtlMs: numberFromEnv(env.DBCHAT_WEB_SESSION_ABSOLUTE_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    turnTimeoutMs: numberFromEnv(env.DBCHAT_WEB_TURN_TIMEOUT_MS, 120_000),
    database: connectionFromEnv(env),
    databaseLabel: env.DBCHAT_WEB_DATABASE_LABEL ?? 'No database configured',
    openRouterApiKey: env.DBCHAT_WEB_OPENROUTER_API_KEY,
    model: env.DBCHAT_WEB_MODEL ?? DEFAULT_WEB_MODEL,
    allowedDatabaseHosts: (env.DBCHAT_WEB_ALLOWED_DATABASE_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
    maxActiveTurnsPerUser: numberFromEnv(env.DBCHAT_WEB_MAX_ACTIVE_TURNS_PER_USER, 2),
    maxActiveTurns: numberFromEnv(env.DBCHAT_WEB_MAX_ACTIVE_TURNS, 16),
    maxChatBodyBytes: numberFromEnv(env.DBCHAT_WEB_MAX_CHAT_BODY_BYTES, 16 * 1024 * 1024),
    maxBodyBytes: numberFromEnv(env.DBCHAT_WEB_MAX_BODY_BYTES, 256 * 1024),
    maxHistoryMessages: numberFromEnv(env.DBCHAT_WEB_MAX_HISTORY_MESSAGES, 40),
    maxMessageChars: numberFromEnv(env.DBCHAT_WEB_MAX_MESSAGE_CHARS, 8_000),
    maxResultRows: numberFromEnv(env.DBCHAT_WEB_MAX_RESULT_ROWS, 100),
    maxResultBytes: numberFromEnv(env.DBCHAT_WEB_MAX_RESULT_BYTES, 1024 * 1024),
    maxSqliteUploadBytes: numberFromEnv(env.DBCHAT_WEB_MAX_SQLITE_UPLOAD_BYTES, 50 * 1024 * 1024),
    sqliteUploadDir: path.resolve(env.DBCHAT_WEB_SQLITE_UPLOAD_DIR ?? path.join(dataDirectory, 'sqlite')),
    userKeyUiEnabled: env.DBCHAT_WEB_USER_KEY_UI_ENABLED === 'true',
    secretKey: env.DBCHAT_WEB_SECRET_KEY
  };
}
