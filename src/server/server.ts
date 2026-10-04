import { OperationLimiter, OperationCapacityError } from './operationLimiter.js';
import { WorkerCoordinator, WorkerLeaseError, TurnCapacityError, type WorkerCoordinatorOptions } from './workerCoordinator.js';
import { DEFAULT_PERSONAL_PROVIDER_MODELS, PERSONAL_PROVIDER_MODELS, validatePersonalProviderKey } from './model/providers.js';
import { ManagedTurnQuotaError, UploadQuotaError } from './turnQuota.js';
import { isIP } from 'node:net';
import { conversationContext, invalidateKnowledge, parseKnowledge, schemaFingerprint, schemaSuggestions } from './conversationContext.js';
import { SupabaseSqliteStorage, type SqliteObjectStorage } from './supabaseSqliteStorage.js';
import { prepareConnectionDestination } from './connectionPolicy.js';
import { createConfiguredConnector } from './connectorFactory.js';
import { classifyQuery } from './connectors/QueryValidator.js';
import { parseElasticsearchQuery } from './connectors/elasticsearchValidation.js';
import { ExportJobs, ExportError, DEFAULT_EXPORT_LIMITS, EXPORT_MIME, type DataFormat, type ExportSnapshot } from './exports/exportJobs.js';
import { SupabaseAssetLifecycle, RetainedSqliteQuotaError, deleteSupabaseAuthUser } from './assetLifecycle.js';
import { SupabaseExportJobs } from './exports/supabaseExportJobs.js';
import type { ExportRepository } from './exports/exportRepository.js';
import { writeDataExport } from './exports/dataExport.js';
import { buildReportDownload, type ReportRequest } from './exports/reportExport.js';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEffortForModel, loadWebServerConfig, type WebServerConfig } from './config.js';
import { AccountStore } from './accountStore.js';
import { RetainedDataQuotaError, SessionCapacityError, SavedDataReadLimitError, type AccountRepository } from './accountRepository.js';
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
const MAX_EVENT_STREAMS = 16;
const MAX_EVENT_STREAMS_PER_ACCOUNT = 2;

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

class RequestBodyLimitError extends Error {
  constructor() { super('Request body is too large.'); }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new RequestBodyLimitError();
    chunks.push(buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyLimitError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new RequestBodyLimitError();
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
  worker?: WorkerCoordinatorOptions;
  validateProviderKey?: typeof validatePersonalProviderKey;
  modelClient?: import('./agent/types.js').AgentModelClient;
  accounts?: AccountRepository;
  sqliteStorage?: SqliteObjectStorage;
  connector?: import('../shared/types.js').DatabaseConnector;
  exportConnectorFactory?: typeof createConfiguredConnector;
}

interface UploadedSqliteFile {
  principalId: string;
  fileName: string;
  filePath?: string;
  objectKey?: string;
  bytes: number;
  createdAt: number;
  claimed?: boolean;
}

interface LoginAttemptWindow {
  attempts: number;
  resetAt: number;
}

export class WebServer {
  readonly accounts: AccountRepository;
  readonly sessions: WebSessionStore;
  readonly service: WebAgentService;
  private readonly validateProviderKey: typeof validatePersonalProviderKey;
  private readonly sqliteStorage?: SqliteObjectStorage;
  private readonly worker: WorkerCoordinator;
  private readonly assets?: SupabaseAssetLifecycle;
  private readonly databaseOperations: OperationLimiter;
  private readonly maxConcurrentRequests: number;
  private activeApiRequests = 0;
  private activeEventStreams = 0;
  private readonly ownerEventStreams = new Map<string, number>();
  private readonly eventStreamResponses = new WeakSet<ServerResponse>();
  private readonly runningTurns = new Map<string, { turn: WebTurnRecord; done: Promise<void> }>();
  private readonly requests = new Set<Promise<void>>();
  private readonly requestCompletion = new WeakMap<IncomingMessage, Promise<void>>();
  private readonly ownerRequests = new Map<string, Set<Promise<void>>>();
  private readonly deletingAccounts = new Set<string>();
  private closing?: Promise<void>;
  private draining = false;
  private readonly sqliteUploads = new Map<string, UploadedSqliteFile>();
  private readonly activeUploads = new Set<string>();
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  private lastUsagePrune = 0;
  private readonly requestBudgets = new Map<string, { count: number; resetAt: number }>();
  private readonly loginAttempts = new Map<string, LoginAttemptWindow>();
  private server: Server | null = null;
  readonly exports: ExportRepository;
  private readonly exportConnectorFactory: typeof createConfiguredConnector;

  constructor(
    readonly config: WebServerConfig,
    options: WebServerOptions = {}
  ) {
    this.maxConcurrentRequests = config.maxConcurrentRequests ?? 8;
    if (!Number.isInteger(this.maxConcurrentRequests) || this.maxConcurrentRequests < 1 || this.maxConcurrentRequests > 128) throw new Error('Invalid concurrent request limit. Choose an integer from 1 to 128.');
    this.databaseOperations = new OperationLimiter(config.maxDatabaseOperations ?? 2);
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
    this.validateProviderKey = options.validateProviderKey ?? validatePersonalProviderKey;
    this.sqliteStorage = options.sqliteStorage ?? (config.storageMode === 'supabase'
      ? new SupabaseSqliteStorage({ url: config.supabase!.url, key: config.supabase!.serviceRoleKey, maxBytes: config.maxSqliteUploadBytes ?? 50 * 1024 * 1024 }) : undefined);
    this.assets = config.storageMode === 'supabase' ? new SupabaseAssetLifecycle(config.supabase!) : undefined;
    this.sessions = new WebSessionStore(config.sessionTtlMs);
    this.worker = new WorkerCoordinator(this.accounts, ids => {
      for (const id of ids) this.runningTurns.get(id)?.turn.abortController.abort();
    }, () => {
      for (const { turn } of this.runningTurns.values()) turn.abortController.abort();
    }, options.worker);
    this.service = new WebAgentService(config, options);
    this.exportConnectorFactory = options.exportConnectorFactory ?? createConfiguredConnector;
    const exportLimits = { ...DEFAULT_EXPORT_LIMITS,
      maxRows: config.exportMaxRows ?? DEFAULT_EXPORT_LIMITS.maxRows,
      maxBytes: config.exportMaxBytes ?? DEFAULT_EXPORT_LIMITS.maxBytes,
      timeoutMs: config.exportTimeoutMs ?? DEFAULT_EXPORT_LIMITS.timeoutMs };
    this.exports = config.storageMode === 'supabase' ? new SupabaseExportJobs(exportLimits, config.supabase!) : new ExportJobs(exportLimits);
  }

  async initialize(): Promise<void> {
    await this.accounts.assertStorageReady?.();
    await this.assets?.assertReady();
    await this.exports.initialize?.();
    await this.accounts.pruneUsage();
    this.lastUsagePrune = Date.now();
    await this.worker.start();
    await this.service.initialize();
    if (!this.sqliteStorage && this.config.sqliteUploadDir) {
      await fs.mkdir(this.config.sqliteUploadDir, { recursive: true });
    }
    if (this.config.authMode === 'dev') {
      await this.accounts.ensureDevelopmentUser();
    }
    this.maintenanceTimer = setInterval(() => {
      if (this.maintenance) return;
      this.maintenance = this.maintainUploadsAndUsage().catch(() => {
        console.error('[dbchat:web] upload cleanup or usage pruning failed');
      }).finally(() => { this.maintenance = undefined; });
    }, 10_000);
    this.maintenanceTimer.unref?.();
  }

  async listen(): Promise<Server> {
    if (this.server) return this.server;
    await this.initialize();
    this.server = http.createServer((request, response) => {
      const done = this.handle(request, response);
      this.requestCompletion.set(request, done);
      this.requests.add(done);
      void done.finally(() => this.requests.delete(done));
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
    if (this.closing) return this.closing;
    this.draining = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.closing = this.drain();
    return this.closing;
  }

  private async drain(): Promise<void> {
    const server = this.server;
    const stopped = server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    for (const { turn } of this.runningTurns.values()) if (!turn.committing) turn.abortController.abort();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      await Promise.allSettled([...this.requests]);
      // Requests admitted before shutdown may have claimed a turn while draining.
      await Promise.allSettled([...this.runningTurns.values()].map(task => task.done));
      await this.exports.close();
      await this.maintenance;
      await this.maintainUploadsAndUsage(true);
    })();
    let timedOut = false;
    try {
      await Promise.race([work, new Promise<void>(resolve => { deadline = setTimeout(() => { timedOut = true; resolve(); }, this.config.shutdownGraceMs ?? 25_000); })]);
    } finally {
      if (deadline) clearTimeout(deadline);
      await this.sessions.flushDurable();
      await this.worker.stop().catch(() => undefined);
      this.sessions.close();
      this.service.close();
      this.sqliteUploads.clear();
      server?.closeAllConnections();
      await stopped;
      this.server = null;
    }
    if (timedOut) throw new Error('Shutdown timed out before active work finished.');
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let settleRequest: (() => void) | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost'));
      if (url.pathname === '/api/health' || url.pathname === '/api/v1/health') {
        const ready = !this.draining && this.worker.ready;
        sendJson(response, ready ? 200 : 503, { ok: ready, ready });
        return;
      }

      if (this.draining) { sendJson(response, 503, { error: 'The server is restarting. Please try again shortly.' }); return; }

      if (url.pathname.startsWith('/api/')) {
        if (this.activeApiRequests >= this.maxConcurrentRequests) {
          response.setHeader('Retry-After', '1');
          sendJson(response, 503, { error: 'The server is busy. Please try again shortly.' });
          return;
        }
        this.activeApiRequests++;
        let handlerSettled = false;
        let responseEnded = response.destroyed || response.writableFinished;
        let released = false;
        const release = () => {
          if (released || !handlerSettled || (!responseEnded && !this.eventStreamResponses.has(response))) return;
          released = true;
          this.activeApiRequests--;
          response.off('finish', ended); response.off('close', ended); response.off('error', ended);
        };
        const ended = () => { responseEnded = true; release(); };
        response.once('finish', ended); response.once('close', ended); response.once('error', ended);
        // Keep the slot while a normal response is buffered for a slow reader.
        // Established SSE responses use their separate lifetime allowance.
        settleRequest = () => { handlerSettled = true; release(); };
        await this.handleApi(request, response, url);
        return;
      }

      await this.serveStatic(response, url.pathname);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof SavedDataReadLimitError || error instanceof RequestBodyLimitError ? 413 : error instanceof RetainedDataQuotaError || error instanceof OperationCapacityError ? 429 : error instanceof WorkerLeaseError ? 503 : error instanceof SyntaxError ? 400 : 500;
      sendJson(response, status, { error: safeClientError(error) });
    } finally { settleRequest?.(); }
  }

  private reserveEventStream(owner: string, response: ServerResponse): (() => void) | undefined {
    const owned = this.ownerEventStreams.get(owner) ?? 0;
    if (this.activeEventStreams >= MAX_EVENT_STREAMS || owned >= MAX_EVENT_STREAMS_PER_ACCOUNT) return undefined;
    this.activeEventStreams++;
    this.ownerEventStreams.set(owner, owned + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeEventStreams--;
      const remaining = (this.ownerEventStreams.get(owner) ?? 1) - 1;
      if (remaining) this.ownerEventStreams.set(owner, remaining);
      else this.ownerEventStreams.delete(owner);
      response.off('finish', release); response.off('close', release); response.off('error', release);
    };
    response.once('finish', release); response.once('close', release); response.once('error', release);
    return release;
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (this.config.allowedOrigin && request.headers.origin && request.headers.origin !== this.config.allowedOrigin) {
      sendJson(response, 403, { error: 'Origin is not allowed.' });
      return;
    }

    const route = this.apiRoute(url.pathname);
    if (route.startsWith('/auth/') && request.method !== 'GET' && !this.takeBudget('auth-request:' + this.clientAddress(request), 120, 60_000)) {
      sendJson(response, 429, { error: 'Too many requests. Try again shortly.' });
      return;
    }

    const legacy = !url.pathname.startsWith('/api/v1/');
    const cookies = parseCookies(request.headers.cookie);
    const secure = this.config.allowedOrigin?.startsWith('https://') === true || secureRequest(request);

    if (route === '/auth/signup' && request.method === 'POST') {
      if (!this.takeBudget('signup:' + this.clientAddress(request), 5, 60_000)) {
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
      } catch (error) {
        if (error instanceof SessionCapacityError) { sendJson(response, 429, { error: error.message }); return; }
        this.recordLoginFailure(attemptKey);
        sendJson(response, 401, { error: 'The email or password is incorrect.' });
      }
      return;
    }

    if ((route === '/auth/forgot-password' || route === '/auth/recovery') && request.method === 'POST') {
      if (!this.accounts.requestPasswordReset || !this.config.allowedOrigin) {
        sendJson(response, 503, { error: 'Password recovery is not configured.' }); return;
      }
      if (!this.takeBudget('recovery:' + this.clientAddress(request), 5, 60_000)) {
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
      if (!this.takeBudget('verify:' + this.clientAddress(request), 10, 60_000)) { sendJson(response, 429, { error: 'Too many verification attempts. Try again later.' }); return; }
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        const type = stringField(body, 'type', true);
        if (type !== 'signup' && type !== 'recovery' && type !== 'email') throw new Error('Invalid verification type.');
        const result = await this.accounts.verifyEmail(stringField(body, 'tokenHash') ?? stringField(body, 'token_hash', true)!, type);
        sendJson(response, 200, { user: result.user, recovery: type === 'recovery', session: { authenticated: type !== 'recovery' } }, authCookie(result.sessionId, secure, this.config.sessionAbsoluteTtlMs));
      } catch (error) { sendJson(response, error instanceof SessionCapacityError ? 429 : 400, { error: error instanceof SessionCapacityError ? error.message : 'This email link is invalid or expired. Request another email.' }); }
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
      const principal = await this.authenticate(request, cookies);
      if (!principal?.email) { sendJson(response, 401, { error: 'Authentication required.' }); return; }
      if (!this.takeBudget('delete-account:' + principal.id, 5, 60_000)) { sendJson(response, 429, { error: 'Too many account attempts. Try again later.' }); return; }
      if (this.deletingAccounts.has(principal.id)) { sendJson(response, 409, { error: 'Account deletion is already in progress.' }); return; }
      this.deletingAccounts.add(principal.id);
      try {
        const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
        await this.accounts.verifyAccountPassword(principal.id, stringField(body, 'password', true)!);
        if (this.assets) {
          // The durable gate must commit before any destructive side effect.
          await this.assets.beginAccountDeletion(principal.id);
          await Promise.resolve(this.accounts.cancelOwnerTurns(principal.id)).catch(() => undefined);
          this.startMaintenance();
          sendJson(response, 202, { ok: true, pending: true, message: 'Account deletion has started and will continue automatically.' }, clearAuthCookie(secure));
          return;
        }
        await this.drainAccount(principal.id);
        const connections = await this.accounts.listConnections(principal.id);
        const files = await Promise.all(connections.map(c => this.accounts.getConnectionConfig(principal.id, c.id)));
        await this.sqliteStorage?.removeOwner(principal.id);
        await this.accounts.deleteAccount(principal.id);
        for (const file of files) if (file?.kind === 'sqlite' && file.databasePath) await this.removeManagedSqliteFile(file.databasePath);
        for (const [id, upload] of this.sqliteUploads) if (upload.principalId === principal.id) { if (upload.filePath) await this.removeManagedSqliteFile(upload.filePath); this.sqliteUploads.delete(id); }
        sendJson(response, 200, { ok: true }, clearAuthCookie(secure));
      } catch { sendJson(response, 400, { error: 'Account could not be deleted. Check your password and wait for active work to finish, then try again.' }); }
      finally { this.deletingAccounts.delete(principal.id); }
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
    if (this.deletingAccounts.has(principal.id)) {
      sendJson(response, 409, { error: 'Account deletion is in progress. Please wait.' }); return;
    }
    if (await this.accounts.isAccountDeleting(principal.id)) { sendJson(response, 409, { error: 'Account deletion is in progress.' }); return; }
    const completion = this.requestCompletion.get(request);
    if (completion) {
      const pending = this.ownerRequests.get(principal.id) ?? new Set<Promise<void>>();
      pending.add(completion);
      this.ownerRequests.set(principal.id, pending);
      void completion.finally(() => { pending.delete(completion); if (!pending.size) this.ownerRequests.delete(principal.id); });
    }
    if (request.method !== 'GET' && !this.takeBudget('request:' + principal.id, 120, 60_000)) {
      sendJson(response, 429, { error: 'Too many requests. Try again shortly.' }); return;
    }

    const legacySession = legacy ? this.sessions.getOrCreateSession(principal, cookies[LEGACY_COOKIE_NAME]) : undefined;
    const legacyCookie = legacySession?.isNew
      ? LEGACY_COOKIE_NAME + '=' + encodeURIComponent(legacySession.id) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800'
      : undefined;

    const exportMatch = route.match(/^\/exports\/([a-f0-9-]+)(?:\/(download|cancel))?$/);
    if (exportMatch) {
      const id = exportMatch[1];
      const job = await this.exports.get(principal.id, id);
      const chatId = await this.exports.chatId(principal.id, id);
      if (!job || !chatId || !await this.accounts.hasChat(principal.id, chatId)) {
        sendJson(response, 404, { error: 'Download expired or unavailable. Generate it again from the chat.' }); return;
      }
      if (request.method === 'GET' && exportMatch[2] === 'download') {
        const stream = await this.exports.read(principal.id, id);
        if (!stream) { sendJson(response, 409, { error: 'This download is not ready.', export: job }); return; }
        const downloadName = job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'db-chat';
        response.writeHead(200, { 'Content-Type': EXPORT_MIME[job.format], 'Content-Disposition': `attachment; filename="${downloadName}-${id.slice(0, 8)}.${job.format === 'markdown' ? 'md' : job.format}"`, 'Content-Length': String(job.byteCount), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
        await pipeline(stream, response); return;
      }
      if (request.method === 'GET' && !exportMatch[2]) { sendJson(response, 200, { export: job }); return; }
      if (request.method === 'POST' && exportMatch[2] === 'cancel') { sendJson(response, 200, { export: await this.exports.cancel(principal.id, id) }); return; }
      if (request.method === 'DELETE' && !exportMatch[2]) { await this.exports.remove(principal.id, id); sendJson(response, 200, { ok: true }); return; }
      sendJson(response, 405, { error: 'Method not allowed.' }); return;
    }

    const createExportMatch = route.match(/^\/chats\/([^/]+)\/exports$/);
    if (request.method === 'GET' && createExportMatch) {
      if (!await this.accounts.hasChat(principal.id, createExportMatch[1])) { sendJson(response, 404, { error: 'Chat not found.' }); return; }
      sendJson(response, 200, { exports: await this.exports.list(principal.id, createExportMatch[1]) }); return;
    }
    if (request.method === 'POST' && createExportMatch) {
      const chat = await this.accounts.getChatSummary(principal.id, createExportMatch[1]);
      if (!chat) { sendJson(response, 404, { error: 'Chat not found.' }); return; }
      try {
        const body = this.requireRecord(await readJson(request, 64 * 1024));
        const artifact = typeof body.resultId === 'string' ? await this.accounts.getChatArtifact(principal.id, chat.id, body.resultId) : null;
        if (!artifact) { sendJson(response, 404, { error: 'Result not found in this chat.' }); return; }
        if (!['csv', 'xlsx', 'json'].includes(String(body.format)) || !['visible', 'all'].includes(String(body.scope))) throw new ExportError('Choose an export format and scope.');
        const format = body.format as DataFormat;
        let job: ExportSnapshot;
        if (body.scope === 'visible') {
          const columns = body.columns === undefined ? artifact.result.columns : body.columns;
          const indices = body.rowIndices === undefined ? artifact.result.rows.map((_row, index) => index) : body.rowIndices;
          if (!Array.isArray(columns) || !columns.length || columns.some(column => typeof column !== 'string' || !artifact.result.columns.includes(column)) || new Set(columns).size !== columns.length) throw new ExportError('Choose existing, distinct result columns.');
          if (!Array.isArray(indices) || indices.length > artifact.result.rows.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= artifact.result.rows.length) || new Set(indices).size !== indices.length) throw new ExportError('Choose existing result rows.');
          const result = { ...artifact.result, columns: columns as string[], rows: indices.map(index => Object.fromEntries((columns as string[]).map(column => [column, artifact.result.rows[index][column] ?? null]))), rowCount: indices.length };
          job = await this.exports.start(principal.id, chat.id, { title: artifact.purpose ?? 'Visible results', format, scope: 'visible' }, context => writeDataExport(format, (async function* () { yield result; })(), context));
        } else {
          if (body.columns !== undefined || body.rowIndices !== undefined) throw new ExportError('All matching results reruns the saved query; local table filters apply only to visible-row exports.');
          job = await this.startQueryExport(principal, chat.id, chat.connectionId, artifact.query, format, artifact.purpose ?? 'All matching results', artifact);
        }
        sendJson(response, 202, { export: job });
      } catch (error) { sendJson(response, error instanceof SavedDataReadLimitError ? 413 : 400, { error: error instanceof ExportError || error instanceof SavedDataReadLimitError ? error.message : 'The export request could not be created.' }); }
      return;
    }

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
      const inference = await this.effectiveInference(principal.id);
      if (body.model !== undefined || body.effortLevel !== undefined || body.provider !== undefined) {
        if (!inference.canChangeModel) {
          sendJson(response, 403, { error: 'Add your own DeepSeek or OpenAI key to choose a model.' }, legacyCookie);
          return;
        }
        if ((body.provider !== undefined && body.provider !== inference.settings.provider)
          || (body.model !== undefined && !inference.models.some(model => model.id === body.model))
          || (body.effortLevel !== undefined && !['none', 'low', 'medium', 'high', 'max'].includes(String(body.effortLevel)))) {
          sendJson(response, 400, { error: 'Choose a supported model and reasoning level for your connected provider.' }, legacyCookie);
          return;
        }
      }
      await this.accounts.updateSettings(principal.id, {
        displayName: stringField(body, 'displayName'),
        activeConnectionId: body.activeConnectionId === null ? null : stringField(body, 'activeConnectionId'),
        model: stringField(body, 'model'),
        effortLevel: stringField(body, 'effortLevel') as WebAccountSettings['effortLevel'] | undefined,
        currentPassword: stringField(body, 'currentPassword'),
        newPassword: stringField(body, 'newPassword')
      });
      sendJson(response, 200, await this.settingsResponse(principal), legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/settings/sessions/revoke') {
      await this.accounts.revokeAllSessions(principal.id);
      sendJson(response, 202, { ok: true }, clearAuthCookie(secure));
      return;
    }

    if (request.method === 'POST' && route === '/settings/openrouter-key') {
      sendJson(response, 410, { error: 'Personal OpenRouter keys are no longer supported. Connect a DeepSeek or OpenAI key in Inference settings.' }, legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/settings/provider-key') {
      if (!this.takeBudget('provider-key:' + principal.id, 10, 60_000)) {
        sendJson(response, 429, { error: 'Too many connection attempts. Try again in a minute.' }, legacyCookie);
        return;
      }
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      if (body.provider !== 'openai' && body.provider !== 'deepseek') {
        sendJson(response, 400, { error: 'Choose DeepSeek or OpenAI.' }, legacyCookie);
        return;
      }
      const apiKey = stringField(body, 'apiKey')?.trim();
      if (!apiKey || apiKey.length < 10 || apiKey.length > 1024 || /[\r\n]/.test(apiKey)) {
        sendJson(response, 400, { error: 'Enter a valid provider key.' }, legacyCookie);
        return;
      }
      try { await this.validateProviderKey(body.provider, apiKey); }
      catch {
        sendJson(response, 422, { error: 'Could not verify this key with the selected provider. Check the key and model access, then try again.' }, legacyCookie);
        return;
      }
      await this.accounts.setUserProviderKey(principal.id, body.provider, apiKey);
      sendJson(response, 202, await this.settingsResponse(principal), legacyCookie);
      return;
    }

    if (request.method === 'DELETE' && (route === '/settings/provider-key' || route === '/settings/openrouter-key')) {
      await this.accounts.removeUserKey(principal.id);
      sendJson(response, 202, await this.settingsResponse(principal), legacyCookie);
      return;
    }

    if (request.method === 'POST' && route === '/sqlite-files') {
      if ((!this.sqliteStorage && !this.config.sqliteUploadDir) || !this.config.maxSqliteUploadBytes) {
        sendJson(response, 503, { error: 'SQLite uploads are not configured on this server.' }, legacyCookie);
        return;
      }
      if (this.activeUploads.has(principal.id) || this.activeUploads.size >= (this.config.maxConcurrentUploads ?? 2)) {
        sendJson(response, 429, { error: 'Wait for an active file upload to finish before trying again.' }, legacyCookie); return;
      }
      this.activeUploads.add(principal.id);
      try {
        const fileName = uploadedFileName(request.headers['x-dbchat-filename']);
        const declaredBytes = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']);
        if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > this.config.maxSqliteUploadBytes)) throw new RequestBodyLimitError();
        await this.accounts.reserveSqliteUpload(principal.id, declaredBytes ?? this.config.maxSqliteUploadBytes, {
          accountCount: this.config.sqliteUploadsPerAccountPerDay ?? 10, globalCount: this.config.sqliteUploadsPerDay ?? 100,
          accountBytes: this.config.sqliteUploadBytesPerAccountPerDay ?? 250 * 1024 * 1024,
          globalBytes: this.config.sqliteUploadBytesPerDay ?? 1024 * 1024 * 1024
        });
        const contents = await readBuffer(request, this.config.maxSqliteUploadBytes);
        if (contents.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('Choose a valid SQLite database file.');
        const asset = await this.assets?.beginUpload(principal.id, fileName, contents.length);
        const uploadId = asset?.id ?? 'upload_' + randomBytes(18).toString('base64url');
        if (this.sqliteStorage) {
          const objectKey = await this.sqliteStorage.upload(principal.id, contents, asset?.objectKey ?? principal.id + '/' + randomUUID() + '.sqlite');
          if (asset) await this.assets!.completeUpload(principal.id, asset.id);
          else this.sqliteUploads.set(uploadId, { principalId: principal.id, fileName, objectKey, bytes: contents.length, createdAt: Date.now() });
        } else {
          const uploadDirectory = await fs.mkdtemp(path.join(this.config.sqliteUploadDir!, uploadId + '-'));
          const filePath = path.join(uploadDirectory, fileName);
          await fs.writeFile(filePath, contents, { flag: 'wx', mode: 0o600 });
          this.sqliteUploads.set(uploadId, { principalId: principal.id, fileName, filePath, bytes: contents.length, createdAt: Date.now() });
        }
        sendJson(response, 201, { uploadId, fileName, bytes: contents.length }, legacyCookie);
      } catch (error) {
        const message = safeClientError(error, 'The SQLite file could not be uploaded.');
        sendJson(response, error instanceof UploadQuotaError || error instanceof RetainedSqliteQuotaError ? 429 : message === 'Request body is too large.' ? 413 : 400, { error: message }, legacyCookie);
      } finally {
        this.activeUploads.delete(principal.id);
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
      const body = this.requireRecord(await readJson(request, Math.min(this.config.maxBodyBytes, this.config.maxChatBodyBytes ?? this.config.maxBodyBytes)));
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
      } catch (error) { sendJson(response, error instanceof SavedDataReadLimitError ? 413 : error instanceof RetainedDataQuotaError || error instanceof SessionCapacityError ? 429 : 400, { error: safeClientError(error) }); }
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
        } catch (error) { sendJson(response, error instanceof SavedDataReadLimitError ? 413 : error instanceof RetainedDataQuotaError || error instanceof SessionCapacityError ? 429 : 400, { error: safeClientError(error) }); return; }
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
      const body = this.requireRecord(await readJson(request, Math.min(this.config.maxBodyBytes, this.config.maxChatBodyBytes ?? this.config.maxBodyBytes)));
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
      if (body.sqliteUploadId !== undefined && body.kind !== 'sqlite') throw new Error('SQLite uploads require a SQLite connection.');
      const claimedUpload = await this.claimSqliteUpload(body, principal);
      let saved = false;
      try {
        const connection = await this.accounts.createConnection(principal.id, this.parseConnection(body, principal));
        saved = true;
        sendJson(response, 201, { connection }, legacyCookie);
      } finally { this.finishSqliteUpload(body, claimedUpload, saved); }
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
      if (body.sqliteUploadId !== undefined && (body.kind ?? previous?.kind) !== 'sqlite') throw new Error('SQLite uploads require a SQLite connection.');
      const claimedUpload = await this.claimSqliteUpload(body, principal);
      let saved = false;
      try {
        const patch = this.parseConnectionPatch(body, principal);
        const connection = await this.accounts.updateConnection(principal.id, connectionMatch[1], patch);
        saved = true;
        if (previous && ((patch.sqliteObjectKey && previous.sqliteObjectKey !== patch.sqliteObjectKey) || (patch.databasePath && previous.databasePath !== patch.databasePath))) await this.removeSqliteConnection(principal.id, previous);
        sendJson(response, 200, { connection }, legacyCookie);
      } finally { this.finishSqliteUpload(body, claimedUpload, saved); }
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

    if (/^\/connections\/[^/]+\/(?:test|schema|introspect|suggestions)$/.test(route)
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
      if (response.destroyed) return;
      const release = this.reserveEventStream(principal.id, response);
      if (!release) {
        response.setHeader('Retry-After', '1');
        sendJson(response, 429, { error: 'Too many open answer streams. Close another viewer and try again.' }, legacyCookie);
        return;
      }
      let subscribed = false;
      try {
        const turn = await this.findTurn(eventMatch[1], principal);
        if (!turn) { sendJson(response, 404, { error: 'Turn not found.' }, legacyCookie); return; }
        if (response.destroyed) return;
        const lastEventId = Number(request.headers['last-event-id'] ?? 0) || 0;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...(legacyCookie ? { 'Set-Cookie': legacyCookie } : {})
        });
        if (turn.chatId) this.sessions.subscribeDurable(principal.id, this.sessions.snapshot(turn), response, lastEventId,
          async () => { this.worker.assertReady(); return await this.accounts.getTurn(principal.id, turn.id); });
        else this.sessions.subscribe(turn, response, lastEventId);
        this.eventStreamResponses.add(response);
        subscribed = true;
      } catch (error) {
        if (response.headersSent) response.destroy();
        throw error;
      } finally { if (!subscribed) release(); }
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
      this.worker.assertReady();
      const body = this.requireRecord(await readJson(request, this.config.maxBodyBytes));
      let messages: ModelChatMessage[];
      try {
        const question = typeof body.question === 'string' ? body.question : Array.isArray(body.messages) ? body.messages.at(-1)?.content : undefined;
        messages = body.chatId || body.question !== undefined ? this.parseMessages({ messages: [{ role: 'user', content: question }] }) : this.parseMessages(body);
      }
      catch (error) { sendJson(response, error instanceof SavedDataReadLimitError ? 413 : error instanceof RetainedDataQuotaError || error instanceof SessionCapacityError ? 429 : 400, { error: safeClientError(error) }, legacyCookie); return; }
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
      const inference = await this.effectiveInference(principal.id);
      if (this.sessions.activeTurnCount(principal.id) >= (this.config.maxActiveTurnsPerUser ?? 2)
        || this.sessions.activeTurnCount() >= (this.config.maxActiveTurns ?? 16)) {
        sendJson(response, 429, { error: 'Wait for an active answer to finish before starting another.' }, legacyCookie);
        return;
      }
      const chatId = stringField(body, 'chatId');
      if (this.config.authMode === 'app' && !chatId) {
        sendJson(response, 400, { error: 'Create a saved chat before asking a question.' }); return;
      }
      const turn = this.sessions.createTurn(principal, messages, selectedConnectionId);
      if (chatId) {
        try {
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
            if ([artifactId, messageId].some(id => id && id.length > 128)) throw new Error('Invalid evidence identifier.');
            turn.intent = { action: effectiveIntent.action as FollowUpIntent['action'], artifactId, messageId, text: stringField(effectiveIntent, 'text')?.slice(0, 4000) };
          }
          const chat = await this.accounts.getChatContext(principal.id, chatId, turn.intent);
          if (!chat || chat.connectionId !== selectedConnectionId) throw new Error('Chat connection does not match.');
          if (turn.intent?.artifactId && !chat.artifacts.some(artifact => artifact.queryId === turn.intent!.artifactId)) throw new Error('Result not found in this chat.');
          if (turn.intent?.messageId && !chat.messages.some(message => message.id === turn.intent!.messageId)) throw new Error('Message not found in this chat.');
          turn.messages = conversationContext(chat, latest.content, turn.intent);
          turn.referencedArtifacts = chat.artifacts;

          const claim = await this.accounts.claimTurn(principal.id, turn.id, chatId, requestId, userMessage, assistantId, {
            workerId: this.worker.id, accountActiveLimit: this.config.maxActiveTurnsPerUser ?? 2, globalActiveLimit: this.config.maxActiveTurns ?? 16,
            managed: inference.credential.source === 'internal', accountDailyLimit: this.config.managedTurnsPerAccountPerDay ?? 100,
            globalDailyLimit: this.config.managedTurnsPerDay ?? 1000, attemptOf: turn.attemptOf, intent: turn.intent
          });
          if (!claim.created) {
            this.sessions.discard(turn);
            sendJson(response, 202, { turnId: claim.turnId }, legacyCookie); return;
          }
        } catch (error) {
          this.sessions.discard(turn);
          sendJson(response, error instanceof SavedDataReadLimitError ? 413 : error instanceof WorkerLeaseError ? 503 : error instanceof ManagedTurnQuotaError || error instanceof TurnCapacityError || error instanceof RetainedDataQuotaError ? 429 : 400, { error: safeClientError(error, 'The question could not be saved.') }); return;
        }
      }
      sendJson(response, 202, { turnId: turn.id }, legacyCookie);
      if (this.draining) turn.abortController.abort();
      const done = this.runTurn(turn, inference);
      this.runningTurns.set(turn.id, { turn, done });
      void done.finally(() => this.runningTurns.delete(turn.id));
      return;
    }

    const abortMatch = route.match(/^\/chat\/turns\/([^/]+)\/abort$/);
    if (request.method === 'POST' && abortMatch) {
      const turn = this.sessions.getTurnForPrincipal(abortMatch[1], principal);
      const saved = await this.accounts.cancelTurn(principal.id, abortMatch[1]);
      if (!turn && !saved) {
        sendJson(response, 404, { error: 'Turn not found.' }, legacyCookie);
        return;
      }
      if (turn && !turn.committing) turn.abortController.abort();
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

  private async drainAccount(owner: string): Promise<void> {
    const abortTurns = () => {
      for (const { turn } of this.runningTurns.values()) if (turn.principalId === owner && !turn.committing) turn.abortController.abort();
    };
    await this.accounts.cancelOwnerTurns(owner);
    abortTurns();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const drained = (async () => {
      // The owner gate prevents later handlers joining this set. Existing
      // uploads must finish before removeOwner, or they can recreate orphan files.
      await Promise.allSettled([...(this.ownerRequests.get(owner) ?? [])]);
      if (timedOut) return;
      abortTurns();
      await Promise.allSettled([...this.runningTurns.values()].filter(task => task.turn.principalId === owner).map(task => task.done));
      if (timedOut) return;
      await this.exports.cancelOwner(owner);
      while (!timedOut && await this.accounts.cancelOwnerTurns(owner) > 0) await new Promise(resolve => setTimeout(resolve, 100));
      if (!timedOut) await this.accounts.recoverExpiredTurns();
    })();
    try {
      await Promise.race([drained, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => { timedOut = true; reject(new Error('Active account work has not finished.')); }, this.config.shutdownGraceMs ?? 25_000);
      })]);
    } finally { if (deadline) clearTimeout(deadline); }
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
    return this.clientAddress(request) + ':' + email.trim().toLowerCase();
  }

  private clientAddress(request: IncomingMessage): string {
    const peer = request.socket.remoteAddress || 'unknown';
    const hops = this.config.trustedProxyHops ?? 0;
    if (!hops) return peer;
    const header = request.headers['x-forwarded-for'];
    const chain = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(value => value.trim());
    const address = chain[chain.length - hops];
    return address && isIP(address) ? address : peer;
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
      provider: WebAccountSettings['provider'];
      model: string;
      canChangeModel: boolean;
      models: Array<{ id: string; name: string }>;
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
    const effective = await this.effectiveInference(principal.id);
    const { settings, credential } = effective;
    let connections = await this.connectionsForPrincipal(principal);
    if (connections.length === 0 && this.config.database && this.config.authMode === 'dev') {
      connections = [publicConfiguredConnection(this.config.database, this.service.getBootstrap().ready)];
    }
    const activeConnectionId = settings.activeConnectionId ?? connections.find((connection) => connection.status === 'ready')?.id;
    return {
      ready: Boolean(activeConnectionId && connections.some((connection) => connection.id === activeConnectionId && connection.status === 'ready')),
      user,
      connections,
      activeConnectionId,
      settings,
      inference: {
        provider: settings.provider,
        model: settings.model,
        canChangeModel: effective.canChangeModel,
        models: effective.models,
        credentialSource: credential.source,
        hasUserKey: credential.hasUserKey,
        userKeyUiEnabled: true,
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

  private async effectiveInference(userId: string) {
    const stored = await this.accounts.getSettings(userId);
    const credential = await this.accounts.resolveProviderKey(userId, this.config.openRouterApiKey);
    const personal = credential.source === 'user' && (credential.provider === 'openai' || credential.provider === 'deepseek');
    if (!personal) {
      return {
        settings: { ...stored, provider: 'openrouter' as const, model: this.config.model, effortLevel: defaultEffortForModel(this.config.model) },
        credential, canChangeModel: false, models: [{ id: this.config.model, name: this.config.model === 'google/gemini-2.5-flash' ? 'Gemini 2.5 Flash' : this.config.model }]
      };
    }
    const provider = credential.provider as 'openai' | 'deepseek';
    const models = PERSONAL_PROVIDER_MODELS[provider];
    const model = stored.provider === provider && models.some(option => option.id === stored.model) ? stored.model : DEFAULT_PERSONAL_PROVIDER_MODELS[provider];
    return { settings: { ...stored, provider, model }, credential, canChangeModel: true, models };
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

  private async startQueryExport(principal: Principal, chatId: string, connectionId: string | undefined, query: string, format: DataFormat, title: string, artifact?: QueryResultArtifact): Promise<ExportSnapshot> {
    if (!connectionId || (artifact?.source && artifact.source.connectionId !== connectionId)) throw new ExportError('The original result connection is unavailable.');
    if (query.length > 100_000 || classifyQuery(query) !== 'read') throw new ExportError('Export requires one read-only query.');
    const connection = await this.connectionConfigForPrincipal(principal, connectionId);
    if (!connection) throw new ExportError('The original database connection is unavailable.');
    if (connection.kind === 'elasticsearch') {
      const parsed = parseElasticsearchQuery(query);
      if (!('operation' in parsed) && (parsed.body.aggs || parsed.body.aggregations)) throw new ExportError('For Elasticsearch summaries, export the visible data or ask for the underlying matching documents. Full downloads require a document search.');
    }
    return this.exports.start(principal.id, chatId, { title, format, scope: 'all' }, async context => {
      // Resolve credentials and pin the destination again for every separate export connection.
      const current = await this.connectionConfigForPrincipal(principal, connectionId);
      if (!current) throw new ExportError('The original database connection is unavailable.');
      await prepareConnectionDestination(current, this.config.allowedDatabaseHosts);
      context.signal.throwIfAborted();
      await this.withSqliteConnection(principal.id, current, async local => {
        const connector = this.exportConnectorFactory(local.kind);
        try {
          connector.setSafetyLevel('safe');
          await connector.connect(local);
          context.signal.throwIfAborted();
          if (!connector.exportQuery) throw new ExportError('Full exports are unavailable for this connection type.');
          await writeDataExport(format, connector.exportQuery(query, { signal: context.signal, batchSize: 500 }), context);
        } finally { connector.close(); }
      }, context.signal);
    });
  }

  private async startReportExport(principal: Principal, chatId: string, request: ReportRequest, artifacts: QueryResultArtifact[]): Promise<ExportSnapshot> {
    const owned = request.resultIds.map(id => artifacts.find(artifact => artifact.queryId === id));
    if (!owned.length || owned.some(artifact => !artifact)) throw new ExportError('Report evidence is unavailable in this chat.');
    return this.exports.start(principal.id, chatId, { title: request.title, format: request.format, scope: 'report' }, async context => {
      context.signal.throwIfAborted();
      const body = buildReportDownload(request, owned as QueryResultArtifact[]);
      const bytes = Buffer.byteLength(body);
      if (bytes > context.limits.maxBytes) throw new ExportError('The report exceeds the download size limit. Use fewer evidence tables.');
      await fs.writeFile(context.filename, body, { mode: 0o600, flag: 'wx', signal: context.signal });
      context.progress(owned.reduce((sum, artifact) => sum + artifact!.result.rows.length, 0), bytes);
    });
  }

  private resolveSqliteUpload(principal: Principal, uploadId: string): Partial<ConnectionConfig> {
    const upload = this.sqliteUploads.get(uploadId);
    if (!upload || upload.principalId !== principal.id || upload.createdAt < Date.now() - 3600_000) {
      throw new Error('Choose a SQLite file again.');
    }
    return upload.objectKey ? { sqliteObjectKey: upload.objectKey, sqliteFileName: upload.fileName, databasePath: '' } : { databasePath: upload.filePath };
  }

  private async claimSqliteUpload(body: Record<string, unknown>, principal: Principal): Promise<UploadedSqliteFile | undefined> {
    if (body.sqliteUploadId === undefined) return undefined;
    const uploadId = stringField(body, 'sqliteUploadId', true)!;
    if (this.assets) {
      const asset = await this.assets.resolveUpload(principal.id, uploadId);
      // This cache only bridges the synchronous connection parser. Attachment is
      // fenced in SQL, so two workers cannot attach the same upload.
      this.sqliteUploads.set(uploadId, { principalId: principal.id, fileName: asset.fileName, objectKey: asset.objectKey, bytes: asset.bytes, createdAt: Date.now(), claimed: true });
      return this.sqliteUploads.get(uploadId);
    }
    const upload = this.sqliteUploads.get(uploadId);
    if (!upload || upload.principalId !== principal.id || upload.claimed || upload.createdAt < Date.now() - 3600_000) throw new Error('Choose a SQLite file again.');
    upload.claimed = true;
    try {
      // The earlier save may have committed even when its HTTP response failed.
      // Reusing that asset would let deletion of either connection break the other.
      if (await this.sqliteUploadIsReferenced(upload)) {
        this.sqliteUploads.delete(uploadId);
        throw new Error('This SQLite file is already attached to a connection. Choose a file again.');
      }
      return upload;
    } catch (error) { upload.claimed = false; throw error; }
  }

  private finishSqliteUpload(body: Record<string, unknown>, claimed: UploadedSqliteFile | undefined, saved: boolean): void {
    if (typeof body.sqliteUploadId !== 'string') return;
    const upload = this.sqliteUploads.get(body.sqliteUploadId);
    if (!upload || upload !== claimed) return;
    if (saved || this.assets) this.sqliteUploads.delete(body.sqliteUploadId);
    else upload.claimed = false;
  }

  private startMaintenance(): void {
    if (this.maintenance || this.draining) return;
    this.maintenance = this.maintainUploadsAndUsage().catch(() => {
      console.error('[dbchat:web] durable cleanup failed; it will retry');
    }).finally(() => { this.maintenance = undefined; });
  }

  private async maintainUploadsAndUsage(shutdown = false): Promise<void> {
    if (this.assets && this.sqliteStorage) {
      const summary = await this.assets.reconcile(this.sqliteStorage, {
        onAccountDeleting: async owner => {
          for (const { turn } of this.runningTurns.values()) if (turn.principalId === owner && !turn.committing) turn.abortController.abort();
          const active = await this.accounts.cancelOwnerTurns(owner);
          await this.accounts.recoverExpiredTurns();
          return active === 0 && !(this.ownerRequests.get(owner)?.size) && !this.activeUploads.has(owner);
        },
        cancelExports: async owner => { try { await this.exports.cancelOwner(owner); return true; } catch { return false; } },
        deleteAuthUser: owner => deleteSupabaseAuthUser(this.config.supabase!, owner)
      });
      if (summary.failed) console.error('[dbchat:web] durable cleanup has retryable failures', { count: summary.failed });
    }
    if (Date.now() - this.lastUsagePrune >= 3600_000) {
      await this.accounts.pruneUsage();
      this.lastUsagePrune = Date.now();
    }
    for (const [id, upload] of this.sqliteUploads) {
      if (this.assets && upload.objectKey) continue;
      if (upload.claimed || (!shutdown && upload.createdAt > Date.now() - 3600_000)) continue;
      // A failed HTTP persistence response can still have committed a connection.
      // Check current references before removing an apparently abandoned file.
      const referenced = await this.sqliteUploadIsReferenced(upload);
      if (upload.claimed) continue;
      upload.claimed = true;
      try {
        if (!referenced) {
          if (upload.objectKey) await this.sqliteStorage?.remove(upload.principalId, upload.objectKey);
          if (upload.filePath) await this.removeManagedSqliteFile(upload.filePath);
        }
        this.sqliteUploads.delete(id);
      } catch (error) { upload.claimed = false; throw error; }
    }
  }

  private async sqliteUploadIsReferenced(upload: UploadedSqliteFile): Promise<boolean> {
    const connections = await this.accounts.listConnections(upload.principalId);
    const configs = await Promise.all(connections.map(connection => this.accounts.getConnectionConfig(upload.principalId, connection.id)));
    return configs.some(config => upload.objectKey ? config?.sqliteObjectKey === upload.objectKey : config?.databasePath === upload.filePath);
  }

  private async withSqliteConnection<T>(owner: string, config: ConnectionConfig, run: (local: ConnectionConfig) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.databaseOperations.run(async () => {
      if (config.kind !== 'sqlite' || !config.sqliteObjectKey) return run(config);
      if (!this.sqliteStorage) throw new Error('Cloud SQLite storage is not configured.');
      return this.sqliteStorage.withConnection(owner, config, run, signal);
    }, signal);
  }

  private async removeSqliteConnection(owner: string, config: ConnectionConfig): Promise<void> {
    if (config.kind !== 'sqlite') return;
    if (config.sqliteObjectKey) {
      if (this.assets) { this.startMaintenance(); return; }
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
    const local = this.sessions.getTurnForPrincipal(id, principal);
    if (local && !local.chatId) return local;
    this.worker.assertReady();
    const saved = await this.accounts.getTurn(principal.id, id);
    if (!saved) return undefined;
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
    if (turn.chatId) {
      const saved = await this.accounts.finalizeTurn(turn.principalId, snapshot, message, artifacts, this.worker.id);
      this.sessions.acceptPersisted(turn, saved);
    } else {
      if (status === 'complete') this.sessions.complete(turn, { message: message!, artifacts, events: [], toolCalls: [] });
      else if (status === 'aborted') this.sessions.abort(turn);
      else this.sessions.fail(turn, error ?? 'The answer could not be completed.');
    }
  }

  private async runTurn(turn: WebTurnRecord, inference: Awaited<ReturnType<WebServer['effectiveInference']>>): Promise<void> {
    turn.executing = true;
    this.sessions.setStatus(turn, 'running');
    this.sessions.publish(turn, 'status', { message: 'Checking the schema' });
    const timeout = setTimeout(() => { if (turn.committing) return; turn.error = 'The answer timed out. Please try a smaller question.'; turn.abortController.abort(); }, this.config.turnTimeoutMs);
    timeout.unref?.();
    let dirty = false;
    let saving: Promise<void> | undefined;
    let saveError: unknown;
    const saveProgress = async () => {
      if (!turn.chatId || !dirty || saveError) return;
      if (saving) { await saving.catch(() => undefined); return; }
      dirty = false;
      const snapshot = structuredClone(this.sessions.snapshot(turn));
      saving = Promise.resolve().then(() => this.accounts.saveTurn(turn.principalId, snapshot, this.worker.id));
      try { await saving; } catch (error) { saveError = error; turn.abortController.abort(); } finally { saving = undefined; }
    };
    const progress = setInterval(() => { void saveProgress(); }, 500); progress.unref?.();
    try {
      this.worker.assertReady();
      if (turn.chatId) await this.accounts.saveTurn(turn.principalId, this.sessions.snapshot(turn), this.worker.id);
      turn.abortController.signal.throwIfAborted();
      const principal: Principal = { id: turn.principalId, roles: ['user'] };
      const connection = turn.connectionId ? await this.connectionConfigForPrincipal(principal, turn.connectionId) : this.config.database;
      if (!connection) throw new Error('The selected connection is no longer available.');
      await prepareConnectionDestination(connection, this.config.allowedDatabaseHosts);
      const { credential: provider, settings } = inference;
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
          dirty = true;
        }, turn.abortController.signal,
        local, provider.apiKey, settings.model, settings.effortLevel, { referencedArtifacts: turn.referencedArtifacts ?? [], knowledge, source,
          requestExport: turn.chatId ? async request => {
            turn.abortController.signal.throwIfAborted();
            const artifacts = [...(turn.artifacts ?? []), ...(turn.referencedArtifacts ?? [])];
            const artifact = request.resultId ? artifacts.find(item => item.queryId === request.resultId) : undefined;
            if (request.resultId && !artifact) throw new ExportError('Result not found in this chat.');
            const job = await this.startQueryExport(principal, turn.chatId!, connection.id, artifact?.query ?? request.query ?? '', request.format, request.title, artifact);
            return { ...job, format: request.format };
          } : undefined,
          requestReport: turn.chatId ? async request => {
            turn.abortController.signal.throwIfAborted();
            const job = await this.startReportExport(principal, turn.chatId!, request, [...(turn.artifacts ?? []), ...(turn.referencedArtifacts ?? [])]);
            return { ...job, format: request.format };
          } : undefined,
          onSchema: async schema => { await this.refreshKnowledgeSchema(turn.principalId, connection.id, schema); } }, settings.provider), turn.abortController.signal);
      turn.metrics = result.metrics ?? result.message.metrics ?? turn.metrics;
      clearInterval(progress);
      await saving;
      await saveProgress();
      if (saveError) throw saveError;
      if (turn.abortController.signal.aborted) throw new Error(turn.error ?? 'Turn cancelled.');
      if (turn.assistantMessageId) {
        result.message.id = turn.assistantMessageId;
        result.artifacts = result.artifacts.map(artifact => ({ ...artifact, messageId: turn.assistantMessageId, source, capturedAt: turn.artifacts?.find(observed => observed.queryId === artifact.queryId)?.capturedAt ?? new Date().toISOString() }));
      }
      // SQL serializes completion against cancellation; the first lock holder wins.
      turn.committing = true;
      await this.persistTerminal(turn, 'complete', result.message, result.artifacts);

    } catch (error) {
      clearInterval(progress);
      await saving?.catch(() => undefined);
      const cancelled = turn.abortController.signal.aborted && !turn.error && !saveError;
      const message = turn.error ?? safeClientError(error, 'The answer could not be generated.');
      try {
        await turn.persistence?.catch(() => undefined);
        await this.persistTerminal(turn, cancelled ? 'aborted' : 'error', undefined, turn.artifacts ?? [], message);
      }
      catch {
        console.error('[dbchat:web] terminal persistence failed', { turnId: turn.id });
        this.sessions.discard(turn);
      }
    } finally {
      turn.executing = false;
      clearInterval(progress);
      clearTimeout(timeout);
      if (turn.chatId) {
        await Promise.resolve().then(() => this.accounts.finishTurnExecution(turn.principalId, turn.id, this.worker.id)).catch(() => undefined);
        // Saved turn reads and event replay use durable snapshots on every worker.
        this.sessions.discard(turn);
      }
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
  startWebServer().then(server => {
    const shutdown = () => {
      // A provider/driver that ignores cancellation must not keep a terminating
      // deployment alive indefinitely. Imported WebServer users are never exited.
      setTimeout(() => { console.error('[dbchat:web] shutdown deadline exceeded'); process.exit(1); }, (server.config.shutdownGraceMs ?? 25_000) + 1000);
      void server.close().then(() => process.exit(0), () => { console.error('[dbchat:web] shutdown failed'); process.exit(1); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }).catch((error) => {
    console.error('[dbchat:web] failed to start', error);
    process.exitCode = 1;
  });
}
