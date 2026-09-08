import { conversationContext, invalidateKnowledge, parseKnowledge, schemaFingerprint, schemaSuggestions } from './conversationContext.js';
import { SupabaseSqliteStorage, type SqliteObjectStorage } from './supabaseSqliteStorage.js';
import { prepareConnectionDestination } from './connectionPolicy.js';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWebServerConfig, type WebServerConfig } from './config.js';
import { AccountStore } from './accountStore.js';
import type { AccountRepository } from './accountRepository.js';
import { SupabaseAccountStore } from './supabaseAccountStore.js';
import { WebSessionStore, type WebTurnRecord } from './sessionStore.js';
import { WebAgentService } from './webAgentService.js';
import type {
  ChatMessage,
  FollowUpIntent,
  DatabaseSchema,
  SourceSnapshot,
  TurnMetrics,
  ConnectionConfig,
  ModelChatMessage,
  QueryResultArtifact
} from '../shared/types.js';
import type { Principal, WebAccountSettings, WebConnectionSummary, WebUser } from './types.js';

const AUTH_COOKIE_NAME = 'dbchat_auth_session';
const LEGACY_COOKIE_NAME = 'dbchat_web_session';

function jsonHeaders(): Record<string, string | string[]> {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
}

function parseCookies(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

function safeClientError(error: unknown, fallback = 'The request could not be completed.'): string {
  const message = error instanceof Error ? error.message : '';
  if (!message || message.length > 240 || /password|secret|token|api[_ -]?key|connection string/i.test(message)) {
    return fallback;
  }
  return message;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('Request body is too large.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function uploadedFileName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) throw new Error('Choose a SQLite database file.');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the original header value; validation below will reject unsafe names.
  }
  const fileName = path.basename(decoded.replaceAll('\\', '/')).trim();
  if (!fileName || fileName.length > 255 || !/\.(?:db|sqlite|sqlite3)$/i.test(fileName)) {
    throw new Error('Choose a SQLite file ending in .db, .sqlite, or .sqlite3.');
  }
  return fileName;
}

function sendJson(response: ServerResponse, status: number, body: unknown, cookies?: string | string[]): void {
  const headers = jsonHeaders();
  if (cookies) headers['Set-Cookie'] = cookies;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function secureRequest(request: IncomingMessage): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  return (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true
    || forwardedProto === 'https'
    || (Array.isArray(forwardedProto) && forwardedProto.includes('https'));
}

function authCookie(id: string, secure: boolean, ttlMs: number): string {
  const maxAge = Math.max(60, Math.floor(ttlMs / 1000));
  return AUTH_COOKIE_NAME + '=' + encodeURIComponent(id)
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
    + (secure ? '; Secure' : '');
}

function clearAuthCookie(secure: boolean): string {
  return AUTH_COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    + (secure ? '; Secure' : '');
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('Complete the required fields.');
    return undefined;
  }
  if (typeof value !== 'string') throw new Error('Invalid ' + key + '.');
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Enter a valid ' + key + '.');
  return parsed;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('Invalid ' + key + '.');
  return value;
}

function publicConfiguredConnection(config: ConnectionConfig, ready: boolean): WebConnectionSummary {
  return {
    id: config.id,
    label: config.label,
    kind: config.kind,
    status: ready ? 'ready' : 'unavailable',
    readOnly: true,
    safeHost: config.kind === 'sqlite' ? 'Local SQLite file' : config.host ?? config.elasticsearchHost,
    sqliteFileName: config.kind === 'sqlite' && config.databasePath ? path.basename(config.databasePath) : undefined,
    hasSavedSecret: Boolean(config.password || config.mongodbUri || config.elasticsearchPassword),
    lastTestedAt: ready ? new Date().toISOString() : undefined,
    createdAt: config.createdAt
  };
}

export interface WebServerOptions {
  modelClient?: import('./agent/types.js').AgentModelClient;
  accounts?: AccountRepository;
  sqliteStorage?: SqliteObjectStorage;
  connector?: import('../shared/types.js').DatabaseConnector;
}

interface UploadedSqliteFile {
  principalId: string;
  fileName: string;
  filePath?: string;
  objectKey?: string;
  bytes: number;
}

interface LoginAttemptWindow {
  attempts: number;
  resetAt: number;
}

export class WebServer {
  readonly accounts: AccountRepository;
  readonly sessions: WebSessionStore;
  readonly service: WebAgentService;
  private readonly sqliteStorage?: SqliteObjectStorage;
  private readonly submittedTurns = new Map<string, string>();
  private readonly sqliteUploads = new Map<string, UploadedSqliteFile>();
  private readonly requestBudgets = new Map<string, { count: number; resetAt: number }>();
  private readonly loginAttempts = new Map<string, LoginAttemptWindow>();
  private server: Server | null = null;

  constructor(
    readonly config: WebServerConfig,
    options: WebServerOptions = {}
  ) {
    this.accounts = options.accounts ?? (config.storageMode === 'supabase'
      ? new SupabaseAccountStore({ ...config.supabase!, secretKey: config.secretKey!, defaultModel: config.model,
        sessionTtlMs: config.sessionTtlMs, sessionAbsoluteTtlMs: config.sessionAbsoluteTtlMs })
      : new AccountStore({
      sessionTtlMs: config.sessionTtlMs,
      sessionAbsoluteTtlMs: config.sessionAbsoluteTtlMs,
      defaultModel: config.model,
      secretKey: config.secretKey,
      secretKeyPath: config.secretKeyPath,
      storePath: config.accountStorePath
    }));
    this.sqliteStorage = options.sqliteStorage ?? (config.storageMode === 'supabase'
      ? new SupabaseSqliteStorage({ url: config.supabase!.url, key: config.supabase!.serviceRoleKey, maxBytes: config.maxSqliteUploadBytes ?? 50 * 1024 * 1024 }) : undefined);
    this.sessions = new WebSessionStore(config.sessionTtlMs);
    this.service = new WebAgentService(config, options);
  }

  async initialize(): Promise<void> {
    await this.accounts.interruptPendingTurns?.();
    await this.service.initialize();
    if (!this.sqliteStorage && this.config.sqliteUploadDir) {
      await fs.mkdir(this.config.sqliteUploadDir, { recursive: true });
    }
    if (this.config.authMode === 'dev') {
      await this.accounts.ensureDevelopmentUser();
    }
  }

  async listen(): Promise<Server> {
    if (this.server) return this.server;
    await this.initialize();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    console.log('[dbchat:web] listening on http://' + this.config.host + ':' + this.config.port);
    console.log('[dbchat:web] auth=' + this.config.authMode + ' data=' + path.dirname(this.config.accountStorePath));
    return this.server;
  }

  async close(): Promise<void> {
    this.service.close();
    // Uploaded SQLite files are durable workspace assets. They are removed only
    // when the owning connection is deleted, not when the server restarts.
    this.sqliteUploads.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost'));
      if (url.pathname === '/api/health' || url.pathname === '/api/v1/health') {
        sendJson(response, 200, { ok: true, ready: true });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(request, response, url);
        return;
      }

      await this.serveStatic(response, url.pathname);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof SyntaxError ? 400 : 500;
      sendJson(response, status, { error: safeClientError(error) });
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (this.config.allowedOrigin && request.headers.origin && request.headers.origin !== this.config.allowedOrigin) {
      sendJson(response, 403, { error: 'Origin is not allowed.' });
      return;
    }

    if (request.method !== 'GET' && !this.takeBudget('request:' + request.socket.remoteAddress, 120, 60_000)) {
      sendJson(response, 429, { error: 'Too many requests. Try again shortly.' });
      return;
    }

    const legacy = !url.pathname.startsWith('/api/v1/');
    const route = this.apiRoute(url.pathname);
    const cookies = parseCookies(request.headers.cookie);
    const secure = this.config.allowedOrigin?.startsWith('https://') === true || secureRequest(request);

    if (route === '/auth/signup' && request.method === 'POST') {
      if (!this.takeBudget('signup:' + request.socket.remoteAddress, 5, 60_000)) {
        sendJson(response, 429, { error: 'Too many account requests. Try again later.' });
        return;
      }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        const result = await this.accounts.signup(
          stringField(body, 'email', true)!,
          stringField(body, 'password', true)!,
          stringField(body, 'displayName')
        );
        sendJson(response, 201, { user: result.user, confirmationRequired: !result.sessionId, session: { authenticated: Boolean(result.sessionId) } }, result.sessionId ? authCookie(result.sessionId, secure, this.config.sessionAbsoluteTtlMs) : undefined);
      } catch (error) {
        sendJson(response, 400, { error: safeClientError(error, 'The account could not be created.') });
      }
      return;
    }

    if (route === '/auth/login' && request.method === 'POST') {
      let email: string;
      let password: string;
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        email = stringField(body, 'email', true)!;
        password = stringField(body, 'password', true)!;
      } catch (error) {
        sendJson(response, 400, { error: safeClientError(error, 'Complete the required fields.') });
        return;
      }
      const attemptKey = this.loginAttemptKey(request, email);
      if (this.loginRateLimited(attemptKey)) {
        sendJson(response, 429, { error: 'Too many login attempts. Try again in a few minutes.' });
        return;
      }
      try {
        const result = await this.accounts.login(email, password);
        this.loginAttempts.delete(attemptKey);
        sendJson(response, 200, { user: result.user, session: { authenticated: true } }, authCookie(result.sessionId, secure, this.config.sessionAbsoluteTtlMs));
      } catch {
        this.recordLoginFailure(attemptKey);
        sendJson(response, 401, { error: 'The email or password is incorrect.' });
      }
      return;
    }

    if ((route === '/auth/forgot-password' || route === '/auth/recovery') && request.method === 'POST') {
      if (!this.accounts.requestPasswordReset || !this.config.allowedOrigin) {
        sendJson(response, 503, { error: 'Password recovery is not configured.' }); return;
      }
      if (!this.takeBudget('recovery:' + request.socket.remoteAddress, 5, 60_000)) {
        sendJson(response, 429, { error: 'Too many recovery requests. Try again later.' }); return;
      }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        await this.accounts.requestPasswordReset(stringField(body, 'email', true)!, new URL('/auth/confirm', this.config.allowedOrigin).toString());
        sendJson(response, 202, { ok: true, message: 'If an account exists, a recovery email will arrive shortly.' });
      } catch { sendJson(response, 400, { error: 'Recovery could not be requested. Please try again.' }); }
      return;
    }

    if (route === '/auth/verify' && request.method === 'POST') {
      if (!this.accounts.verifyEmail) { sendJson(response, 503, { error: 'Email verification is not configured.' }); return; }
      if (!this.takeBudget('verify:' + request.socket.remoteAddress, 10, 60_000)) { sendJson(response, 429, { error: 'Too many verification attempts. Try again later.' }); return; }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        const type = stringField(body, 'type', true);
        if (type !== 'signup' && type !== 'recovery' && type !== 'email') throw new Error('Invalid verification type.');
        const result = await this.accounts.verifyEmail(stringField(body, 'tokenHash') ?? stringField(body, 'token_hash', true)!, type);
        sendJson(response, 200, { user: result.user, recovery: type === 'recovery', session: { authenticated: type !== 'recovery' } }, authCookie(result.sessionId, secure, this.config.sessionAbsoluteTtlMs));
      } catch { sendJson(response, 400, { error: 'This email link is invalid or expired. Request another email.' }); }
      return;
    }

    if (route === '/auth/reset-password' && request.method === 'POST') {
      if (!this.accounts.resetPassword) { sendJson(response, 503, { error: 'Password recovery is not configured.' }); return; }
      const sessionId = cookies[AUTH_COOKIE_NAME];
      if (!sessionId) { sendJson(response, 401, { error: 'Open the password recovery link from your email.' }); return; }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        await this.accounts.resetPassword(sessionId, stringField(body, 'password') ?? stringField(body, 'newPassword', true)!);
        sendJson(response, 200, { ok: true }, clearAuthCookie(secure));
      } catch { sendJson(response, 400, { error: 'Password could not be reset. Use at least 8 characters and a valid recovery link.' }); }
      return;
    }

    if (route === '/account' && request.method === 'DELETE') {
      if (!this.accounts.deleteAccount) { sendJson(response, 503, { error: 'Account deletion is not configured.' }); return; }
      if (!this.takeBudget('delete-account:' + request.socket.remoteAddress, 5, 60_000)) { sendJson(response, 429, { error: 'Too many account attempts. Try again later.' }); return; }
      const principal = await this.authenticate(request, cookies);
      if (!principal?.email) { sendJson(response, 401, { error: 'Authentication required.' }); return; }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        const confirmation = await this.accounts.login(principal.email, stringField(body, 'password', true)!);
        if (confirmation.user.id !== principal.id) throw new Error('Account verification failed.');
        await this.accounts.revokeSession(confirmation.sessionId);
        const connections = await this.accounts.listConnections(principal.id);
        const files = await Promise.all(connections.map(c => this.accounts.getConnectionConfig(principal.id, c.id)));
        await this.sqliteStorage?.removeOwner(principal.id);
        await this.accounts.deleteAccount(principal.id);
        for (const file of files) if (file?.kind === 'sqlite' && file.databasePath) await this.removeManagedSqliteFile(file.databasePath);
        for (const [id, upload] of this.sqliteUploads) if (upload.principalId === principal.id) { if (upload.filePath) await this.removeManagedSqliteFile(upload.filePath); this.sqliteUploads.delete(id); }
        sendJson(response, 200, { ok: true }, clearAuthCookie(secure));
      } catch { sendJson(response, 400, { error: 'Account could not be deleted. Check your password and try again.' }); }
      return;
    }

    if (route === '/auth/logout' && request.method === 'POST') {
      await this.accounts.revokeSession(cookies[AUTH_COOKIE_NAME]);
      sendJson(response, 200, { ok: true }, clearAuthCookie(secure));
      return;
    }

    if (route === '/auth/me' && request.method === 'GET') {
      const principal = await this.authenticate(request, cookies);
      if (!principal) {
        sendJson(response, 200, { authenticated: false });
        return;
      }
      const sessionToken = cookies[AUTH_COOKIE_NAME];
      sendJson(
        response,
        200,
        { authenticated: true, user: await this.userForPrincipal(principal) },
        this.config.authMode === 'app' && sessionToken
          ? authCookie(sessionToken, secure, this.config.sessionAbsoluteTtlMs)
          : undefined
      );
      return;
    }

    const principal = await this.authenticate(request, cookies);
    if (!principal) {
      sendJson(response, 401, { error: 'Authentication required.' });
      return;
    }

    const legacySession = this.sessions.getOrCreateSession(principal, cookies[LEGACY_COOKIE_NAME]);
    const legacyCookie = legacySession.isNew
      ? LEGACY_COOKIE_NAME + '=' + encodeURIComponent(legacySession.id) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800'
      : undefined;

    if (request.method === 'GET' && route === '/bootstrap') {
      const bootstrap = await this.buildBootstrap(principal);
      if (legacy) {
        const legacyDatabase = this.service.getBootstrap().database;
        sendJson(response, 200, {
          ready: bootstrap.ready,
          database: bootstrap.connections[0] ? {
            label: bootstrap.connections[0].label,
            kind: bootstrap.connections[0].kind,
            tableCount: bootstrap.connections[0].tableCount ?? legacyDatabase.tableCount,
            readOnly: true
          } : {
            label: this.config.databaseLabel,
            tableCount: 0,
            readOnly: true
          },
          limits: bootstrap.limits,
          model: bootstrap.inference.model,
          capabilities: bootstrap.capabilities,
          session: { authenticated: true, displayName: principal.displayName ?? principal.id },
          user: bootstrap.user
        }, legacyCookie);
      } else {
        sendJson(response, 200, bootstrap, legacyCookie);
      }
      return;
    }

    if (request.method === 'GET' && route === '/settings') {
      sendJson(response, 200, await this.settingsResponse(principal), legacyCookie);
      return;
    }

    if (request.method === 'PATCH' && route === '/settings') {
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      const result = await this.accounts.updateSettings(principal.id, {
        displayName: stringField(body, 'displayName'),
        activeConnectionId: body.activeConnectionId === null ? null : stringField(body, 'activeConnectionId'),
        model: stringField(body, 'model'),
        effortLevel: stringField(body, 'effortLevel') as WebAccountSettings['effortLevel'] | undefined,
        currentPassword: stringField(body, 'currentPassword'),
        newPassword: stringField(body, 'newPassword')
      });
      sendJson(response, 200, { user: result.user, settings: result.settings }, legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/settings/sessions/revoke') {
      await this.accounts.revokeAllSessions(principal.id);
      sendJson(response, 202, { ok: true }, clearAuthCookie(secure));
      return;
    }

    if (request.method === 'POST' && route === '/settings/openrouter-key') {
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      await this.accounts.setUserKey(principal.id, stringField(body, 'apiKey', true)!);
      sendJson(response, 202, {
        hasUserKey: true,
        credentialSource: 'user',
        userKeyUiEnabled: Boolean(this.config.userKeyUiEnabled)
      }, legacyCookie);
      return;
    }

    if (request.method === 'DELETE' && route === '/settings/openrouter-key') {
      await this.accounts.removeUserKey(principal.id);
      sendJson(response, 202, {
        hasUserKey: false,
        credentialSource: this.config.openRouterApiKey ? 'internal' : 'none',
        userKeyUiEnabled: Boolean(this.config.userKeyUiEnabled)
      }, legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/sqlite-files') {
      if ((!this.sqliteStorage && !this.config.sqliteUploadDir) || !this.config.maxSqliteUploadBytes) {
        sendJson(response, 503, { error: 'SQLite uploads are not configured on this server.' }, legacyCookie);
        return;
      }
      try {
        const fileName = uploadedFileName(request.headers['x-dbchat-filename']);
        const contents = await readBuffer(request, this.config.maxSqliteUploadBytes);
        const uploadId = 'upload_' + randomBytes(18).toString('base64url');
        if (this.sqliteStorage) {
          const objectKey = await this.sqliteStorage.upload(principal.id, contents);
          this.sqliteUploads.set(uploadId, { principalId: principal.id, fileName, objectKey, bytes: contents.length });
        } else {
          const uploadDirectory = await fs.mkdtemp(path.join(this.config.sqliteUploadDir!, uploadId + '-'));
          const filePath = path.join(uploadDirectory, fileName);
          await fs.writeFile(filePath, contents, { flag: 'wx', mode: 0o600 });
          this.sqliteUploads.set(uploadId, { principalId: principal.id, fileName, filePath, bytes: contents.length });
        }
        sendJson(response, 201, { uploadId, fileName, bytes: contents.length }, legacyCookie);
      } catch (error) {
        const message = safeClientError(error, 'The SQLite file could not be uploaded.');
        sendJson(response, message === 'Request body is too large.' ? 413 : 400, { error: message }, legacyCookie);
      }
      return;
    }

    if (request.method === 'GET' && route === '/connections') {
      sendJson(response, 200, { connections: await this.connectionsForPrincipal(principal) }, legacyCookie);
      return;
    }

    if (request.method === 'GET' && route === '/chats') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const connectionId = url.searchParams.get('connectionId');
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      sendJson(response, 200, await this.accounts.searchChats(principal.id, { q, connectionId: connectionId ?? undefined, pinned: url.searchParams.get('pinned') === 'true', offset, limit }), legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/chats') {
      const body = this.requireRecord(await readJson(request, this.config.maxChatBodyBytes ?? 16 * 1024 * 1024));
      const connectionId = stringField(body, 'connectionId');
      if (connectionId && !await this.connectionSummaryForPrincipal(principal, connectionId)) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      const summary = connectionId ? await this.connectionSummaryForPrincipal(principal, connectionId) : null;
      const chat = await this.accounts.createChat(principal.id, connectionId, summary ? { connectionId: summary.id, label: summary.label, kind: summary.kind, capturedAt: new Date().toISOString() } : undefined);
      sendJson(response, 201, { chat }, legacyCookie);
      return;
    }

    const messageMetadataMatch = route.match(/^\/chats\/([^/]+)\/messages\/([^/]+)(\/feedback)?$/);
    if (messageMetadataMatch && (request.method === 'PATCH' || request.method === 'POST')) {
      const body = this.requireRecord(await readJson(request, 8192));
      try {
        const patch: Pick<ChatMessage, 'feedback' | 'pinned'> = {};
        if (messageMetadataMatch[3] && request.method === 'POST') {
          if (body.rating !== 'helpful' && body.rating !== 'unhelpful') throw new Error('Choose helpful or unhelpful.');
          const correction = stringField(body, 'correction');
          if (correction && correction.length > 4000) throw new Error('Correction is too long.');
          patch.feedback = { rating: body.rating, correction, updatedAt: new Date().toISOString() };
        } else {
          if (request.method !== 'PATCH' || typeof body.pinned !== 'boolean') throw new Error('Provide pinned as a boolean.');
          patch.pinned = body.pinned;
        }
        const chat = await this.accounts.updateMessageMetadata(principal.id, messageMetadataMatch[1], messageMetadataMatch[2], patch);
        sendJson(response, 200, { chat }, legacyCookie);
      } catch (error) { sendJson(response, 400, { error: safeClientError(error) }); }
      return;
    }

    const knowledgeMatch = route.match(/^\/connections\/([^/]+)\/knowledge$/);
    if (knowledgeMatch && ['GET', 'PUT'].includes(request.method ?? '')) {
      if (!await this.connectionSummaryForPrincipal(principal, knowledgeMatch[1])) { sendJson(response, 404, { error: 'Connection not found.' }); return; }
      let knowledge = await this.accounts.getConnectionKnowledge(principal.id, knowledgeMatch[1]);
      if (request.method === 'PUT') {
        try {
          const body = this.requireRecord(await readJson(request, 128 * 1024));
          knowledge = await this.accounts.saveConnectionKnowledge(principal.id, knowledgeMatch[1], parseKnowledge(body.knowledge ?? body, knowledge));
        } catch (error) { sendJson(response, 400, { error: safeClientError(error) }); return; }
      }
      sendJson(response, 200, { knowledge }, legacyCookie); return;
    }

    const chatMatch = route.match(/^\/chats\/([^/]+)$/);
    if (chatMatch && request.method === 'GET') {
      const paginated = url.searchParams.has('limit') || url.searchParams.has('before');
      const chat = paginated ? await this.accounts.getChatPage(principal.id, chatMatch[1], { before: url.searchParams.get('before') ?? undefined, limit: Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50)) }) : await this.accounts.getChat(principal.id, chatMatch[1]);
      if (!chat) {
        sendJson(response, 404, { error: 'Chat not found.' }, legacyCookie);
        return;
      }
      chat.sourceAvailable = Boolean(chat.connectionId && (await this.connectionSummaryForPrincipal(principal, chat.connectionId))?.status === 'ready');
      if (chat.latestTurn && (!paginated || ['queued', 'running'].includes(chat.latestTurn.status))) {
        const turn = await this.findTurn(chat.latestTurn.id, principal);
        if (turn) chat.latestTurn = paginated ? { ...this.sessions.snapshot(turn), events: [], artifacts: undefined } : this.sessions.snapshot(turn);
      }
      sendJson(response, 200, { chat }, legacyCookie);
      return;
    }

    if (chatMatch && request.method === 'PATCH') {
      const body = this.requireRecord(await readJson(request, this.config.maxChatBodyBytes ?? 16 * 1024 * 1024));
      if (Object.keys(body).some(key => !['title', 'pinned'].includes(key)) || (body.pinned !== undefined && typeof body.pinned !== 'boolean')) {
        sendJson(response, 400, { error: 'Only title and pinned can be changed. Saved evidence and source are server-owned.' }); return;
      }
      const chat = await this.accounts.updateChat(principal.id, chatMatch[1], {
        title: body.title === undefined ? undefined : stringField(body, 'title', true),
        pinned: body.pinned as boolean | undefined
      });
      sendJson(response, 200, { chat }, legacyCookie);
      return;
    }

    if (chatMatch && request.method === 'DELETE') {
      if (!await this.accounts.deleteChat(principal.id, chatMatch[1])) {
        sendJson(response, 404, { error: 'Chat not found.' }, legacyCookie);
        return;
      }
      sendJson(response, 200, { ok: true }, legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/connections') {
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      const connection = await this.accounts.createConnection(principal.id, this.parseConnection(body, principal));
      sendJson(response, 201, { connection }, legacyCookie);
      return;
    }

    const connectionMatch = route.match(/^\/connections\/([^/]+)$/);
    if (connectionMatch && request.method === 'GET') {
      const connection = await this.accounts.getConnectionSummary(principal.id, connectionMatch[1]);
      if (!connection) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      sendJson(response, 200, { connection }, legacyCookie);
      return;
    }

    if (connectionMatch && request.method === 'PATCH') {
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      const previous = await this.connectionConfigForPrincipal(principal, connectionMatch[1]);
      const patch = this.parseConnectionPatch(body, principal);
      const connection = await this.accounts.updateConnection(principal.id, connectionMatch[1], patch);
      if (previous && patch.sqliteObjectKey && previous.sqliteObjectKey !== patch.sqliteObjectKey) await this.removeSqliteConnection(principal.id, previous);
      sendJson(response, 200, { connection }, legacyCookie);
      return;
    }

    if (connectionMatch && request.method === 'DELETE') {
      const connectionConfig = await this.connectionConfigForPrincipal(principal, connectionMatch[1]);
      if (!await this.accounts.deleteConnection(principal.id, connectionMatch[1])) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      if (connectionConfig) await this.removeSqliteConnection(principal.id, connectionConfig);
      sendJson(response, 200, { ok: true }, legacyCookie);
      return;
    }

    if (/^\/connections\/[^/]+\/(?:test|schema|introspect)$/.test(route)
      && (!this.takeBudget('database:' + principal.id, 20, 60_000) || !this.takeBudget('database:global', 100, 60_000))) {
      sendJson(response, 429, { error: 'Too many database checks. Try again shortly.' }, legacyCookie);
      return;
    }

    const testMatch = route.match(/^\/connections\/([^/]+)\/test$/);
    if (testMatch && request.method === 'POST') {
      const connectionConfig = await this.connectionConfigForPrincipal(principal, testMatch[1]);
      if (!connectionConfig) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      try {
        await prepareConnectionDestination(connectionConfig, this.config.allowedDatabaseHosts);
        const schema = await this.withSqliteConnection(principal.id, connectionConfig, local => this.service.getSchema(local));
        const isVirtualConfiguredConnection = this.config.authMode === 'dev'
          && this.config.database?.id === testMatch[1];
        const connection = isVirtualConfiguredConnection
          ? publicConfiguredConnection(this.config.database!, true)
          : await this.accounts.markConnectionTest(principal.id, testMatch[1], { ok: true, tableCount: schema.tables.length });
        sendJson(response, 200, {
          connection,
          health: { status: 'ready', tableCount: schema.tables.length }
        }, legacyCookie);
      } catch (error) {
        const message = safeClientError(error, 'We could not reach this database. Check the host, port, and network access, then try again.');
        const isVirtualConfiguredConnection = this.config.authMode === 'dev'
          && this.config.database?.id === testMatch[1];
        const connection = isVirtualConfiguredConnection
          ? publicConfiguredConnection(this.config.database!, false)
          : await this.accounts.markConnectionTest(principal.id, testMatch[1], { ok: false, error: message });
        sendJson(response, 422, { connection, error: message, health: { status: 'unavailable' } }, legacyCookie);
      }
      return;
    }

    const schemaMatch = route.match(/^\/connections\/([^/]+)\/(?:schema|introspect|suggestions)$/);
    if (schemaMatch && request.method === 'GET') {
      const connection = await this.connectionSummaryForPrincipal(principal, schemaMatch[1]);
      const connectionConfig = await this.connectionConfigForPrincipal(principal, schemaMatch[1]);
      if (!connection || !connectionConfig) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      try {
        await prepareConnectionDestination(connectionConfig, this.config.allowedDatabaseHosts);
        const schema = await this.withSqliteConnection(principal.id, connectionConfig, local => this.service.testConnection(local));
        await this.refreshKnowledgeSchema(principal.id, schemaMatch[1], schema);
        sendJson(response, 200, route.endsWith('/suggestions') ? { suggestions: schemaSuggestions(schema) } : { schema }, legacyCookie);
      } catch (error) {
        sendJson(response, 422, { error: safeClientError(error, 'The schema could not be loaded.') }, legacyCookie);
      }
      return;
    }

    const eventMatch = route.match(/^\/chat\/turns\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventMatch) {
      const turn = await this.findTurn(eventMatch[1], principal);
      if (!turn) {
        sendJson(response, 404, { error: 'Turn not found.' }, legacyCookie);
        return;
      }
      const lastEventId = Number(request.headers['last-event-id'] ?? 0) || 0;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(legacyCookie ? { 'Set-Cookie': legacyCookie } : {})
      });
      this.sessions.subscribe(turn, response, lastEventId);
      return;
    }

    const turnMatch = route.match(/^\/chat\/turns\/([^/]+)$/);
    if (request.method === 'GET' && turnMatch) {
      const turn = await this.findTurn(turnMatch[1], principal);
      if (!turn) {
        sendJson(response, 404, { error: 'Turn not found.' }, legacyCookie);
        return;
      }
      sendJson(response, 200, this.sessions.snapshot(turn), legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/chat/turns') {
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      let messages: ModelChatMessage[];
      try {
        const question = typeof body.question === 'string' ? body.question : Array.isArray(body.messages) ? body.messages.at(-1)?.content : undefined;
        messages = body.chatId || body.question !== undefined ? this.parseMessages({ messages: [{ role: 'user', content: question }] }) : this.parseMessages(body);
      }
      catch (error) { sendJson(response, 400, { error: safeClientError(error) }, legacyCookie); return; }
      if (typeof body.chatId === 'string' && typeof body.clientRequestId === 'string') {
        const prior = await this.accounts.getTurnByRequestId(principal.id, body.clientRequestId);
        if (prior) {
          if (prior.chatId !== body.chatId) { sendJson(response, 400, { error: 'Request belongs to another chat.' }); return; }
          sendJson(response, 202, { turnId: prior.id }, legacyCookie); return;
        }
      }
      const selectedConnectionId = stringField(body, 'connectionId')
        ?? (await this.buildBootstrap(principal)).activeConnectionId;
      if (!selectedConnectionId) {
        sendJson(response, 409, { error: 'Add a connection before asking a question.' }, legacyCookie);
        return;
      }
      const selected = await this.connectionSummaryForPrincipal(principal, selectedConnectionId);
      if (!selected) {
        sendJson(response, 404, { error: 'Connection not found.' }, legacyCookie);
        return;
      }
      if (selected.status !== 'ready') {
        sendJson(response, 409, { error: 'This connection is unavailable. Manage it before asking a question.' }, legacyCookie);
        return;
      }
      if (this.sessions.activeTurnCount(principal.id) >= (this.config.maxActiveTurnsPerUser ?? 2)
        || this.sessions.activeTurnCount() >= (this.config.maxActiveTurns ?? 16)) {
        sendJson(response, 429, { error: 'Wait for an active answer to finish before starting another.' }, legacyCookie);
        return;
      }
      const chatId = stringField(body, 'chatId');
      if (this.config.storageMode === 'supabase' && !chatId) {
        sendJson(response, 400, { error: 'Create a saved chat before asking a question.' }); return;
      }
      const turn = this.sessions.createTurn(principal, messages, selectedConnectionId);
      if (chatId) {
        try {
          const chat = await this.accounts.getChat(principal.id, chatId);
          if (!chat || chat.connectionId !== selectedConnectionId) throw new Error('Chat connection does not match.');
          const requestId = stringField(body, 'clientRequestId', true)!;
          const assistantId = stringField(body, 'assistantMessageId', true)!;
          const userId = stringField(body, 'userMessageId', true)!;
          if ([chatId, requestId, assistantId, userId].some(id => id.length > 128)) throw new Error('Invalid message identifier.');
          const latest = messages.at(-1);
          if (latest?.role !== 'user' || typeof latest.content !== 'string') throw new Error('End the request with a question.');
          const userMessage: ChatMessage = { id: userId, role: 'user', content: latest.content, createdAt: turn.createdAt };
          turn.chatId = chatId; turn.assistantMessageId = assistantId; turn.question = latest.content;
          let effectiveIntent: unknown = body.intent;
          if (body.attemptOf !== undefined) {
            const attempt = await this.accounts.getTurn(principal.id, stringField(body, 'attemptOf', true)!);
            if (!attempt || attempt.chatId !== chatId || ['queued', 'running'].includes(attempt.status)) throw new Error('Choose a finished attempt from this chat.');
            turn.attemptOf = attempt.id;
            if (effectiveIntent === undefined) effectiveIntent = attempt.intent;
          }
          if (effectiveIntent !== undefined) {
            if (!isRecord(effectiveIntent) || !['compare', 'filter', 'explain', 'inspect-exceptions', 'change-chart', 'rerun'].includes(String(effectiveIntent.action))) throw new Error('Invalid follow-up action.');
            const artifactId = stringField(effectiveIntent, 'artifactId');
            const messageId = stringField(effectiveIntent, 'messageId');
            if (!artifactId && !messageId) throw new Error('Choose the answer or result for this action.');
            if (artifactId && !chat.artifacts.some(artifact => artifact.queryId === artifactId)) throw new Error('Result not found in this chat.');
            if (messageId && !chat.messages.some(message => message.id === messageId)) throw new Error('Message not found in this chat.');
            turn.intent = { action: effectiveIntent.action as FollowUpIntent['action'], artifactId, messageId, text: stringField(effectiveIntent, 'text')?.slice(0, 4000) };
          }
          turn.messages = conversationContext(chat, latest.content, turn.intent);
          turn.referencedArtifacts = chat.artifacts;

          const key = principal.id + ':' + requestId;
          const prior = this.submittedTurns.get(key);
          const claim = this.accounts.claimTurn
            ? await this.accounts.claimTurn(principal.id, turn.id, chatId, requestId, userMessage, assistantId)
            : { turnId: prior ?? turn.id, created: !prior };
          if (!claim.created) {
            this.sessions.discard(turn);
            sendJson(response, 202, { turnId: claim.turnId }, legacyCookie); return;
          }
          this.submittedTurns.set(key, turn.id);
          await this.accounts.saveTurn(principal.id, this.sessions.snapshot(turn));
        } catch (error) {
          this.sessions.discard(turn);
          sendJson(response, 400, { error: safeClientError(error, 'The question could not be saved.') }); return;
        }
      }
      sendJson(response, 202, { turnId: turn.id }, legacyCookie);
      void this.runTurn(turn);
      return;
    }

    const abortMatch = route.match(/^\/chat\/turns\/([^/]+)\/abort$/);
    if (request.method === 'POST' && abortMatch) {
      const turn = this.sessions.getTurnForPrincipal(abortMatch[1], principal);
      if (!turn) {
        sendJson(response, 404, { error: 'Turn not found.' }, legacyCookie);
        return;
      }
      if (!turn.committing) turn.abortController.abort();
      sendJson(response, 202, { ok: true }, legacyCookie);
      return;
    }

    sendJson(response, 404, { error: 'API route not found.' }, legacyCookie);
  }

  private apiRoute(pathname: string): string {
    if (pathname.startsWith('/api/v1/')) return pathname.slice('/api/v1'.length);
    if (pathname.startsWith('/api/')) return pathname.slice('/api'.length);
    return pathname;
  }

  private takeBudget(key: string, maximum: number, windowMs: number): boolean {
    const now = Date.now();
    for (const [id, budget] of this.requestBudgets) if (budget.resetAt <= now) this.requestBudgets.delete(id);
    const budget = this.requestBudgets.get(key) ?? { count: 0, resetAt: now + windowMs };
    budget.count += 1;
    this.requestBudgets.set(key, budget);
    return budget.count <= maximum;
  }

  private loginAttemptKey(request: IncomingMessage, email: string): string {
    return (request.socket.remoteAddress || 'unknown') + ':' + email.trim().toLowerCase();
  }

  private loginRateLimited(key: string): boolean {
    const window = this.loginAttempts.get(key);
    if (!window) return false;
    if (window.resetAt <= Date.now()) {
      this.loginAttempts.delete(key);
      return false;
    }
    return window.attempts >= 5;
  }

  private recordLoginFailure(key: string): void {
    const now = Date.now();
    for (const [id, entry] of this.loginAttempts) if (entry.resetAt <= now) this.loginAttempts.delete(id);
    const window = this.loginAttempts.get(key);
    if (!window || window.resetAt <= now) {
      this.loginAttempts.set(key, { attempts: 1, resetAt: now + 15 * 60 * 1000 });
      return;
    }
    window.attempts += 1;
  }

  private async authenticate(request: IncomingMessage, cookies = parseCookies(request.headers.cookie)): Promise<Principal | null> {
    if (this.config.authMode === 'dev') {
      const user = await this.accounts.ensureDevelopmentUser();
      return {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        emailVerified: user.emailVerified,
        roles: ['user']
      };
    }
    return await this.accounts.principalForSession(cookies[AUTH_COOKIE_NAME]);
  }

  private async userForPrincipal(principal: Principal): Promise<WebUser> {
    return await this.accounts.getUser(principal.id) ?? {
      id: principal.id,
      email: principal.email ?? principal.id,
      displayName: principal.displayName ?? principal.id,
      emailVerified: principal.emailVerified ?? false,
      createdAt: new Date().toISOString()
    };
  }

  private async buildBootstrap(principal: Principal): Promise<{
    ready: boolean;
    user: WebUser;
    connections: WebConnectionSummary[];
    activeConnectionId?: string;
    settings: WebAccountSettings;
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
  }> {
    const user = await this.userForPrincipal(principal);
    let settings: WebAccountSettings;
    try {
      settings = await this.accounts.getSettings(principal.id);
    } catch {
      settings = { provider: 'openrouter', model: this.config.model, effortLevel: 'medium' };
    }
    let connections = await this.connectionsForPrincipal(principal);
    if (connections.length === 0 && this.config.database && this.config.authMode === 'dev') {
      connections = [publicConfiguredConnection(this.config.database, this.service.getBootstrap().ready)];
    }
    const activeConnectionId = settings.activeConnectionId ?? connections.find((connection) => connection.status === 'ready')?.id;
    const credential = await this.accounts.resolveProviderKey(principal.id, this.config.openRouterApiKey);
    return {
      ready: Boolean(activeConnectionId && connections.some((connection) => connection.id === activeConnectionId && connection.status === 'ready')),
      user,
      connections,
      activeConnectionId,
      settings,
      inference: {
        provider: 'openrouter',
        model: settings.model || this.config.model,
        credentialSource: credential.source,
        hasUserKey: credential.hasUserKey,
        userKeyUiEnabled: Boolean(this.config.userKeyUiEnabled),
        status: credential.source === 'none' ? 'unavailable' : 'ready'
      },
      capabilities: { queryResults: true, csvExport: true, charts: true },
      limits: {
        maxHistoryMessages: this.config.maxHistoryMessages,
        maxMessageChars: this.config.maxMessageChars,
        maxResultRows: this.config.maxResultRows,
        maxResultBytes: this.config.maxResultBytes,
        maxSqliteUploadBytes: this.config.maxSqliteUploadBytes
      }
    };
  }

  private async settingsResponse(principal: Principal): Promise<Record<string, unknown>> {
    const bootstrap = await this.buildBootstrap(principal);
    return {
      user: bootstrap.user,
      settings: bootstrap.settings,
      inference: bootstrap.inference,
      connections: bootstrap.connections
    };
  }

  private async connectionsForPrincipal(principal: Principal): Promise<WebConnectionSummary[]> {
    const connections = await this.accounts.listConnections(principal.id);
    if (connections.length > 0 || !this.config.database || this.config.authMode !== 'dev') {
      return connections;
    }
    return [publicConfiguredConnection(this.config.database, this.service.getBootstrap().ready)];
  }

  private async connectionSummaryForPrincipal(principal: Principal, id: string): Promise<WebConnectionSummary | null> {
    return (await this.connectionsForPrincipal(principal)).find((connection) => connection.id === id) ?? null;
  }

  private async connectionConfigForPrincipal(principal: Principal, id: string): Promise<ConnectionConfig | null> {
    if (this.config.authMode === 'dev' && this.config.database?.id === id) {
      return this.config.database;
    }
    return await this.accounts.getConnectionConfig(principal.id, id);
  }

  private resolveSqliteUpload(principal: Principal, uploadId: string): Partial<ConnectionConfig> {
    const upload = this.sqliteUploads.get(uploadId);
    if (!upload || upload.principalId !== principal.id) {
      throw new Error('Choose a SQLite file again.');
    }
    // Each uploaded asset belongs to one connection; prevent reuse and shared deletion.
    this.sqliteUploads.delete(uploadId);
    return upload.objectKey ? { sqliteObjectKey: upload.objectKey, sqliteFileName: upload.fileName, databasePath: '' } : { databasePath: upload.filePath };
  }

  private async withSqliteConnection<T>(owner: string, config: ConnectionConfig, run: (local: ConnectionConfig) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (config.kind !== 'sqlite' || !config.sqliteObjectKey) return run(config);
    if (!this.sqliteStorage) throw new Error('Cloud SQLite storage is not configured.');
    return this.sqliteStorage.withConnection(owner, config, run, signal);
  }

  private async removeSqliteConnection(owner: string, config: ConnectionConfig): Promise<void> {
    if (config.kind !== 'sqlite') return;
    if (config.sqliteObjectKey) {
      if (!this.sqliteStorage) throw new Error('Cloud SQLite storage is not configured.');
      await this.sqliteStorage.remove(owner, config.sqliteObjectKey);
    } else if (config.databasePath) await this.removeManagedSqliteFile(config.databasePath);
  }

  private async removeManagedSqliteFile(filePath: string): Promise<void> {
    if (!this.config.sqliteUploadDir) return;
    const root = path.resolve(this.config.sqliteUploadDir);
    const candidate = path.resolve(filePath);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    const parent = path.dirname(candidate);
    await fs.rm(parent === root ? candidate : parent, { recursive: true, force: true });
  }

  private async refreshKnowledgeSchema(userId: string, connectionId: string, schema: DatabaseSchema): Promise<void> {
    const knowledge = await this.accounts.getConnectionKnowledge(userId, connectionId);
    const fingerprint = schemaFingerprint(schema);
    if (knowledge.schemaFingerprint !== fingerprint) await this.accounts.saveConnectionKnowledge(userId, connectionId, invalidateKnowledge(knowledge, fingerprint));
  }

  private async findTurn(id: string, principal: Principal): Promise<WebTurnRecord | undefined> {
    const active = this.sessions.getTurnForPrincipal(id, principal);
    if (active) return active;
    const saved = await this.accounts.getTurn?.(principal.id, id);
    if (!saved) return undefined;
    // This deployment runs one Node instance. An unfinalized persisted turn after
    // process loss is interrupted, never silently executed for a second time.
    if (saved.status === 'queued' || saved.status === 'running') {
      saved.status = 'error'; saved.error = 'The server restarted before this answer finished. Please ask again.';
      saved.events = [...saved.events, { id: saved.events.length + 1, turnId: id, type: 'error', timestamp: new Date().toISOString(), data: { message: saved.error } }];
      await this.accounts.finalizeTurn?.(principal.id, saved);
    }
    return { ...saved, principalId: principal.id, messages: [], eventBytes: 0,
      createdAt: saved.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
      abortController: new AbortController(), subscribers: new Set() };
  }

  private async persistTerminal(turn: WebTurnRecord, status: 'complete' | 'error' | 'aborted', message?: ChatMessage, artifacts: QueryResultArtifact[] = [], error?: string): Promise<void> {
    if (!message && turn.assistantMessageId) message = { id: turn.assistantMessageId, role: 'assistant', content: status === 'aborted' ? 'Answer stopped.' : error ?? 'The answer could not be completed.', createdAt: new Date().toISOString() };
    if (message && turn.metrics) message.metrics ??= turn.metrics;
    if (message) message.turn = { id: turn.id, status, question: turn.question ?? turn.messages.at(-1)?.content ?? '', attemptOf: turn.attemptOf, intent: turn.intent };
    turn.message = message;
    const data = status === 'complete' ? { message, artifacts, artifactIds: artifacts.map(a => a.queryId) } : { message: error ?? 'Turn cancelled.' };
    const snapshot = { ...this.sessions.snapshot(turn), status, message, artifacts, error,
      events: [...turn.events, { id: turn.events.length + 1, turnId: turn.id, type: status, timestamp: new Date().toISOString(), data }] };
    if (this.accounts.finalizeTurn) await this.accounts.finalizeTurn(turn.principalId, snapshot, message, artifacts);
    else if (turn.chatId) {
      const chat = await this.accounts.getChat(turn.principalId, turn.chatId);
      if (!chat) throw new Error('The chat is no longer available.');
      await this.accounts.updateChat(turn.principalId, turn.chatId, {
        messages: message ? [...chat.messages.filter(m => m.id !== message.id), message] : chat.messages,
        artifacts: [...chat.artifacts, ...artifacts]
      });
    }
  }

  private async runTurn(turn: WebTurnRecord): Promise<void> {
    turn.executing = true;
    this.sessions.setStatus(turn, 'running');
    this.sessions.publish(turn, 'status', { message: 'Checking the schema' });
    const timeout = setTimeout(() => { if (turn.committing) return; turn.error = 'The answer timed out. Please try a smaller question.'; turn.abortController.abort(); }, this.config.turnTimeoutMs);
    timeout.unref?.();
    try {
      await this.accounts.saveTurn?.(turn.principalId, this.sessions.snapshot(turn));
      const principal: Principal = { id: turn.principalId, roles: ['user'] };
      const connection = turn.connectionId ? await this.connectionConfigForPrincipal(principal, turn.connectionId) : this.config.database;
      if (!connection) throw new Error('The selected connection is no longer available.');
      await prepareConnectionDestination(connection, this.config.allowedDatabaseHosts);
      const provider = await this.accounts.resolveProviderKey(turn.principalId, this.config.openRouterApiKey);
      const settings = await this.accounts.getSettings(turn.principalId);
      const knowledge = await this.accounts.getConnectionKnowledge(turn.principalId, connection.id);
      const source: SourceSnapshot = { connectionId: connection.id, label: connection.label, kind: connection.kind, capturedAt: new Date().toISOString() };
      const result = await this.withSqliteConnection(turn.principalId, connection, local => this.service.run(turn.messages, turn.id,
        event => {
          if (isRecord(event.data.metrics)) turn.metrics = event.data.metrics as unknown as TurnMetrics;
          if (event.type === 'result' && isRecord(event.data.artifact) && event.data.artifact.kind === 'query-result') {
            const artifact = { ...event.data.artifact, messageId: turn.assistantMessageId, source, capturedAt: new Date().toISOString() } as unknown as QueryResultArtifact;
            turn.artifacts = [...(turn.artifacts ?? []).filter(item => item.queryId !== artifact.queryId), artifact];
            event = { ...event, data: { ...event.data, artifact } };
          }
          this.sessions.publishAgentEvent(turn, event);
          if (event.type === 'result') {
            const snapshot = structuredClone(this.sessions.snapshot(turn));
            turn.persistence = (turn.persistence ?? Promise.resolve()).then(async () => { await this.accounts.saveTurn(turn.principalId, snapshot); });
            // A rejected save is reconciled by the awaited chain before finalization.
            void turn.persistence.catch(() => undefined);
          }
        }, turn.abortController.signal,
        local, provider.apiKey, settings.model, settings.effortLevel, { referencedArtifacts: turn.referencedArtifacts ?? [], knowledge, source, onSchema: async schema => { await this.refreshKnowledgeSchema(turn.principalId, connection.id, schema); } }), turn.abortController.signal);
      turn.metrics = result.metrics ?? result.message.metrics ?? turn.metrics;
      await turn.persistence;
      if (turn.abortController.signal.aborted) throw new Error(turn.error ?? 'Turn cancelled.');
      if (turn.assistantMessageId) {
        result.message.id = turn.assistantMessageId;
        result.artifacts = result.artifacts.map(artifact => ({ ...artifact, messageId: turn.assistantMessageId, source, capturedAt: turn.artifacts?.find(observed => observed.queryId === artifact.queryId)?.capturedAt ?? new Date().toISOString() }));
      }
      // Once the database commit begins, cancellation cannot undo that answer.
      turn.committing = true;
      await this.persistTerminal(turn, 'complete', result.message, result.artifacts);
      this.sessions.complete(turn, result);
    } catch (error) {
      const cancelled = turn.abortController.signal.aborted && !turn.error;
      const message = turn.error ?? safeClientError(error, 'The answer could not be generated.');
      try {
        await turn.persistence?.catch(() => undefined);
        await this.persistTerminal(turn, cancelled ? 'aborted' : 'error', undefined, turn.artifacts ?? [], message);
      }
      catch { console.error('[dbchat:web] terminal persistence failed', { turnId: turn.id }); }
      if (cancelled) this.sessions.abort(turn);
      else this.sessions.fail(turn, message);
    } finally {
      turn.executing = false;
      clearTimeout(timeout);
    }
  }

  private parseMessages(body: Record<string, unknown>): ModelChatMessage[] {
    if (!Array.isArray(body.messages)) throw new Error('Request must include a messages array.');
    if (body.messages.length === 0 || body.messages.length > this.config.maxHistoryMessages) {
      throw new Error('Messages must contain between 1 and ' + this.config.maxHistoryMessages + ' items.');
    }
    return body.messages.map((message) => {
      if (!isRecord(message)) throw new Error('Invalid message.');
      const role = message.role;
      const content = message.content;
      if (role !== 'user' && role !== 'assistant') throw new Error('Only user and assistant messages are accepted.');
      if (typeof content !== 'string' || !content.trim() || content.length > this.config.maxMessageChars) {
        throw new Error('Message content is empty or too large.');
      }
      return { role, content } as ModelChatMessage;
    });
  }

  private parseConnection(body: Record<string, unknown>, principal: Principal): ConnectionConfig {
    const kind = stringField(body, 'kind', true) as ConnectionConfig['kind'];
    const label = stringField(body, 'label', true)!;
    let databasePath = stringField(body, 'databasePath');
    let sqliteFields: Partial<ConnectionConfig> = {};
    if (kind === 'sqlite') {
      const uploadId = stringField(body, 'sqliteUploadId');
      if (uploadId) {
        sqliteFields = this.resolveSqliteUpload(principal, uploadId);
      } else if (this.config.authMode !== 'dev') {
        databasePath = undefined;
      }
    }
    const config: ConnectionConfig = {
      id: '',
      kind,
      label,
      createdAt: new Date().toISOString(),
      databasePath,
      ...sqliteFields,
      host: stringField(body, 'host'),
      port: numberField(body, 'port'),
      database: stringField(body, 'database'),
      username: stringField(body, 'username'),
      password: stringField(body, 'password'),
      ssl: booleanField(body, 'ssl'),
      elasticsearchHost: stringField(body, 'elasticsearchHost'),
      elasticsearchPort: numberField(body, 'elasticsearchPort'),
      elasticsearchUrl: stringField(body, 'elasticsearchUrl'),
      elasticsearchUsername: stringField(body, 'elasticsearchUsername'),
      elasticsearchPassword: stringField(body, 'elasticsearchPassword'),
      elasticsearchUseSsl: booleanField(body, 'elasticsearchUseSsl'),
      elasticsearchVerifyCerts: booleanField(body, 'elasticsearchVerifyCerts'),
      mongodbUri: stringField(body, 'mongodbUri'),
      safetyLevel: 'safe'
    };
    return config;
  }

  private parseConnectionPatch(body: Record<string, unknown>, principal: Principal): Partial<ConnectionConfig> {
    const patch: Partial<ConnectionConfig> = {};
    if ('label' in body) patch.label = stringField(body, 'label', true);
    if ('kind' in body) patch.kind = stringField(body, 'kind', true) as ConnectionConfig['kind'];
    if ('sqliteUploadId' in body) {
      Object.assign(patch, this.resolveSqliteUpload(principal, stringField(body, 'sqliteUploadId', true)!));
    } else if ('databasePath' in body && this.config.authMode === 'dev') {
      patch.databasePath = stringField(body, 'databasePath');
    }
    if ('host' in body) patch.host = stringField(body, 'host');
    if ('port' in body) patch.port = numberField(body, 'port');
    if ('database' in body) patch.database = stringField(body, 'database');
    if ('username' in body) patch.username = stringField(body, 'username');
    if ('password' in body && body.password) patch.password = stringField(body, 'password');
    if ('ssl' in body) patch.ssl = booleanField(body, 'ssl');
    if ('mongodbUri' in body) patch.mongodbUri = stringField(body, 'mongodbUri');
    if ('elasticsearchUrl' in body) patch.elasticsearchUrl = stringField(body, 'elasticsearchUrl');
    if ('elasticsearchHost' in body) patch.elasticsearchHost = stringField(body, 'elasticsearchHost');
    if ('elasticsearchPort' in body) patch.elasticsearchPort = numberField(body, 'elasticsearchPort');
    if ('elasticsearchUsername' in body) patch.elasticsearchUsername = stringField(body, 'elasticsearchUsername');
    if ('elasticsearchPassword' in body && body.elasticsearchPassword) patch.elasticsearchPassword = stringField(body, 'elasticsearchPassword');
    if ('elasticsearchUseSsl' in body) patch.elasticsearchUseSsl = booleanField(body, 'elasticsearchUseSsl');
    if ('elasticsearchVerifyCerts' in body) patch.elasticsearchVerifyCerts = booleanField(body, 'elasticsearchVerifyCerts');
    return patch;
  }

  private requireRecord(body: unknown): Record<string, unknown> {
    if (!isRecord(body)) throw new Error('Request body must be an object.');
    return body;
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const root = path.resolve(this.config.staticDir);
    let filePath = path.resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'"
      });
      response.end(body);
    } catch {
      if (path.extname(pathname)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Build the web client with npm run web:build first.');
        return;
      }
      filePath = path.join(root, 'index.html');
      try {
        const body = await fs.readFile(filePath);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'"
        });
        response.end(body);
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Build the web client with npm run web:build first.');
      }
    }
  }
}

export async function startWebServer(config = loadWebServerConfig()): Promise<WebServer> {
  const server = new WebServer(config);
  await server.listen();
  return server;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFile === invokedFile) {
  startWebServer().catch((error) => {
    console.error('[dbchat:web] failed to start', error);
    process.exitCode = 1;
  });
}
