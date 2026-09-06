import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import fs from 'node:fs';
import { publicConnectionUri } from '../shared/connectionSecrets.js';
import path from 'node:path';
import type {
  ChatMessage,
  ConnectionConfig,
  EffortLevel,
  QueryResultArtifact,
  WebChatSession,
  WebChatSummary
} from '../shared/types.js';
import type {
  Principal,
  WebAccountSettings,
  WebConnectionStatus,
  WebConnectionSummary,
  WebUser
} from './types.js';

interface StoredSession {
  idHash: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
}

interface StoredUser {
  id: string;
  email: string;
  displayName: string;
  passwordHash?: string;
  passwordSalt?: string;
  emailVerified: boolean;
  createdAt: string;
  settings: WebAccountSettings;
  encryptedProviderKey?: string;
}

export interface StoredConnection {
  id: string;
  userId: string;
  config: ConnectionConfig;
  encryptedSecrets?: string;
  status: WebConnectionStatus;
  lastTestedAt?: string;
  tableCount?: number;
  lastError?: string;
}

export interface StoredChatSession extends WebChatSession {
  userId: string;
  customTitle?: boolean;
}

export interface ConnectionSecrets {
  elasticsearchUrl?: string;
  password?: string;
  mongodbUri?: string;
  elasticsearchPassword?: string;
}

interface AccountStoreSnapshot {
  version: 1 | 2;
  users: StoredUser[];
  connections: StoredConnection[];
  chats?: StoredChatSession[];
  sessions?: StoredSession[];
}

function loadOrCreateSecretKey(keyPath: string): string {
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(keyPath, generated + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return fs.readFileSync(keyPath, 'utf8').trim();
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertPassword(password: string): void {
  if (password.length < 8) throw new Error('Use at least 8 characters for your password.');
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString('hex')
  };
}

function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class SecretVault {
  private readonly key: Buffer;

  constructor(seed?: string, keyPath?: string) {
    this.key = createHash('sha256')
      .update(seed ?? (keyPath ? loadOrCreateSecretKey(keyPath) : randomBytes(32).toString('hex')))
      .digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64url'), authTag.toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  decrypt(value: string): string {
    const parts = value.split('.');
    const ivText = parts[0];
    const tagText = parts[1];
    const encryptedText = parts[2];
    if (!ivText || !tagText || !encryptedText) throw new Error('Stored secret is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }
}

export function splitSecrets(config: ConnectionConfig): { config: ConnectionConfig; secrets?: ConnectionSecrets } {
  const { password, mongodbUri, elasticsearchPassword, elasticsearchUrl, ...safeConfig } = config;
  const secrets: ConnectionSecrets = { password, mongodbUri, elasticsearchPassword, elasticsearchUrl };
  return {
    config: { ...safeConfig, elasticsearchUrl: publicConnectionUri(elasticsearchUrl) },
    secrets: Object.values(secrets).some((value) => Boolean(value)) ? secrets : undefined
  };
}

function safeHost(config: ConnectionConfig): string | undefined {
  if (config.kind === 'sqlite') return 'Local SQLite file';
  return config.host ?? config.elasticsearchHost ?? (config.mongodbUri ? 'MongoDB connection' : undefined);
}

function sqliteFileName(config: ConnectionConfig): string | undefined {
  if (config.kind === 'sqlite' && config.sqliteObjectKey) return config.sqliteFileName;
  return config.kind === 'sqlite' && config.databasePath
    ? path.basename(config.databasePath)
    : undefined;
}

export function displayConnection(stored: StoredConnection): WebConnectionSummary {
  return {
    id: stored.id,
    label: stored.config.label,
    kind: stored.config.kind,
    status: stored.status,
    readOnly: true,
    safeHost: safeHost(stored.config),
    host: stored.config.host ?? stored.config.elasticsearchHost,
    port: stored.config.port ?? stored.config.elasticsearchPort,
    database: stored.config.database,
    username: stored.config.username ?? stored.config.elasticsearchUsername,
    ssl: stored.config.ssl ?? stored.config.elasticsearchUseSsl,
    elasticsearchUrl: publicConnectionUri(stored.config.elasticsearchUrl),
    elasticsearchVerifyCerts: stored.config.elasticsearchVerifyCerts,
    sqliteFileName: sqliteFileName(stored.config),
    hasSavedSecret: Boolean(stored.encryptedSecrets),
    lastTestedAt: stored.lastTestedAt,
    tableCount: stored.tableCount,
    lastError: stored.lastError,
    createdAt: stored.config.createdAt
  };
}

export function chatTitle(messages: ChatMessage[]): string {
  const question = messages.find((message) => message.role === 'user')?.content.trim();
  if (!question) return 'New chat';
  const singleLine = question.replace(/\s+/g, ' ');
  return singleLine.length > 72 ? singleLine.slice(0, 69) + '…' : singleLine;
}

export function customChatTitle(title: string): string {
  const singleLine = title.trim().replace(/\s+/g, ' ');
  if (!singleLine) throw new Error('Enter a chat name.');
  if (singleLine.length > 72) throw new Error('Chat names can be up to 72 characters.');
  return singleLine;
}

export function displayChat(stored: StoredChatSession): WebChatSession {
  return {
    id: stored.id,
    title: stored.title,
    connectionId: stored.connectionId,
    messageCount: stored.messages.length,
    artifactCount: stored.artifacts.length,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    messages: stored.messages.map((message) => ({ ...message })),
    artifacts: stored.artifacts.map((artifact) => ({
      ...artifact,
      result: {
        ...artifact.result,
        columns: [...artifact.result.columns],
        rows: artifact.result.rows.map((row) => ({ ...row }))
      }
    }))
  };
}

export function summarizeChat(stored: StoredChatSession): WebChatSummary {
  return {
    id: stored.id,
    title: stored.title,
    connectionId: stored.connectionId,
    messageCount: stored.messages.length,
    artifactCount: stored.artifacts.length,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  };
}

export interface CreateUserResult {
  user: WebUser;
  sessionId: string;
}

export interface LoginResult {
  user: WebUser;
  sessionId: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  tableCount?: number;
  error?: string;
}

export class AccountStore {
  private readonly users = new Map<string, StoredUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly connections = new Map<string, StoredConnection>();
  private readonly chats = new Map<string, StoredChatSession>();
  private readonly vault: SecretVault;
  private readonly sessionTtlMs: number;
  private readonly sessionAbsoluteTtlMs: number;
  private readonly defaultModel: string;
  private readonly storePath?: string;

  constructor(options: { sessionTtlMs: number; sessionAbsoluteTtlMs?: number; defaultModel: string; secretKey?: string; secretKeyPath?: string; storePath?: string }) {
    this.sessionTtlMs = options.sessionTtlMs;
    this.sessionAbsoluteTtlMs = options.sessionAbsoluteTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.defaultModel = options.defaultModel;
    this.storePath = options.storePath;
    this.vault = new SecretVault(options.secretKey, options.secretKeyPath);
    this.load();
  }

  ensureDevelopmentUser(): WebUser {
    const existing = this.users.get('dev-user');
    if (existing) return this.toUser(existing);
    const user: StoredUser = {
      id: 'dev-user',
      email: 'dev@dbchat.local',
      displayName: 'Development user',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      settings: this.defaultSettings()
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
    this.persist();
    return this.toUser(user);
  }

  signup(email: string, password: string, displayName?: string): CreateUserResult {
    const normalizedEmail = normalizeEmail(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      throw new Error('Enter a valid email address.');
    }
    assertPassword(password);
    if (this.usersByEmail.has(normalizedEmail)) {
      throw new Error('Unable to create an account with those details.');
    }
    const id = 'user_' + randomBytes(12).toString('hex');
    const passwordRecord = hashPassword(password);
    const user: StoredUser = {
      id,
      email: normalizedEmail,
      displayName: displayName?.trim() || normalizedEmail.split('@')[0],
      passwordHash: passwordRecord.hash,
      passwordSalt: passwordRecord.salt,
      emailVerified: false,
      createdAt: new Date().toISOString(),
      settings: this.defaultSettings()
    };
    this.users.set(id, user);
    this.usersByEmail.set(normalizedEmail, id);
    this.persist();
    return { user: this.toUser(user), sessionId: this.createSession(id) };
  }

  login(email: string, password: string): LoginResult {
    const userId = this.usersByEmail.get(normalizeEmail(email));
    const user = userId ? this.users.get(userId) : undefined;
    if (!user?.passwordHash || !user.passwordSalt || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      throw new Error('The email or password is incorrect.');
    }
    return { user: this.toUser(user), sessionId: this.createSession(user.id) };
  }

  principalForSession(sessionId: string | undefined): Principal | null {
    if (!sessionId) return null;
    const idHash = this.sessionHash(sessionId);
    const session = this.sessions.get(idHash);
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      if (session) {
        this.sessions.delete(idHash);
        this.persist();
      }
      return null;
    }
    // Refresh at a bounded cadence rather than rewriting every authenticated read.
    if (now - session.lastSeenAt >= Math.min(60_000, this.sessionTtlMs / 4)) {
      session.lastSeenAt = now;
      session.expiresAt = Math.min(now + this.sessionTtlMs, session.absoluteExpiresAt);
      this.persist();
    }
    const user = this.users.get(session.userId);
    return user ? this.toPrincipal(user) : null;
  }

  revokeSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    const session = this.sessions.get(this.sessionHash(sessionId));
    if (session) {
      session.revokedAt = Date.now();
      this.persist();
    }
  }

  revokeAllSessions(userId: string): void {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  getUser(userId: string): WebUser | null {
    const user = this.users.get(userId);
    return user ? this.toUser(user) : null;
  }

  getSettings(userId: string): WebAccountSettings {
    const user = this.users.get(userId);
    if (!user) throw new Error('Account not found.');
    return { ...user.settings };
  }

  updateSettings(userId: string, patch: {
    displayName?: string;
    activeConnectionId?: string | null;
    model?: string;
    effortLevel?: EffortLevel;
    currentPassword?: string;
    newPassword?: string;
  }): { user: WebUser; settings: WebAccountSettings } {
    const user = this.users.get(userId);
    if (!user) throw new Error('Account not found.');
    if (patch.displayName !== undefined) {
      const displayName = patch.displayName.trim();
      if (!displayName) throw new Error('Display name cannot be empty.');
      if (displayName.length > 80) throw new Error('Display name is too long.');
      user.displayName = displayName;
    }
    if (patch.activeConnectionId !== undefined) {
      if (patch.activeConnectionId !== null) {
        const connection = this.connections.get(patch.activeConnectionId);
        if (!connection || connection.userId !== userId) throw new Error('Choose one of your connections.');
      }
      user.settings.activeConnectionId = patch.activeConnectionId ?? undefined;
    }
    if (patch.model !== undefined) user.settings.model = patch.model.trim() || this.defaultModel;
    if (patch.effortLevel !== undefined) user.settings.effortLevel = patch.effortLevel;
    if (patch.newPassword !== undefined) {
      if (!patch.currentPassword || !user.passwordSalt || !user.passwordHash || !verifyPassword(patch.currentPassword, user.passwordSalt, user.passwordHash)) {
        throw new Error('Your current password is incorrect.');
      }
      assertPassword(patch.newPassword);
      const passwordRecord = hashPassword(patch.newPassword);
      user.passwordSalt = passwordRecord.salt;
      user.passwordHash = passwordRecord.hash;
    }
    this.persist();
    return { user: this.toUser(user), settings: { ...user.settings } };
  }

  listConnections(userId: string): WebConnectionSummary[] {
    return [...this.connections.values()]
      .filter((connection) => connection.userId === userId)
      .sort((a, b) => a.config.label.localeCompare(b.config.label))
      .map(displayConnection);
  }

  listChats(userId: string): WebChatSummary[] {
    return [...this.chats.values()]
      .filter((chat) => chat.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(summarizeChat);
  }

  getChat(userId: string, chatId: string): WebChatSession | null {
    const chat = this.chats.get(chatId);
    return chat?.userId === userId ? displayChat(chat) : null;
  }

  createChat(userId: string, connectionId?: string): WebChatSession {
    this.assertUser(userId);
    const now = new Date().toISOString();
    const chat: StoredChatSession = {
      id: 'chat_' + randomBytes(12).toString('hex'),
      userId,
      title: 'New chat',
      customTitle: false,
      connectionId,
      messageCount: 0,
      artifactCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
      artifacts: []
    };
    this.chats.set(chat.id, chat);
    this.persist();
    return displayChat(chat);
  }

  updateChat(userId: string, chatId: string, patch: {
    title?: string;
    connectionId?: string;
    messages?: ChatMessage[];
    artifacts?: QueryResultArtifact[];
  }): WebChatSession {
    const chat = this.chats.get(chatId);
    if (!chat || chat.userId !== userId) throw new Error('Chat not found.');
    if (patch.title !== undefined) {
      chat.title = customChatTitle(patch.title);
      chat.customTitle = true;
    }
    if (patch.connectionId !== undefined) {
      chat.connectionId = patch.connectionId;
    }
    if (patch.messages !== undefined) chat.messages = patch.messages.map((message) => ({ ...message }));
    if (patch.artifacts !== undefined) chat.artifacts = patch.artifacts.map((artifact) => ({
      ...artifact,
      result: {
        ...artifact.result,
        columns: [...artifact.result.columns],
        rows: artifact.result.rows.map((row) => ({ ...row }))
      }
    }));
    if (patch.title === undefined && !chat.customTitle) chat.title = chatTitle(chat.messages);
    chat.messageCount = chat.messages.length;
    chat.artifactCount = chat.artifacts.length;
    chat.updatedAt = new Date().toISOString();
    this.persist();
    return displayChat(chat);
  }

  deleteChat(userId: string, chatId: string): boolean {
    const chat = this.chats.get(chatId);
    if (!chat || chat.userId !== userId) return false;
    this.chats.delete(chatId);
    this.persist();
    return true;
  }

  createConnection(userId: string, input: ConnectionConfig, testResult?: ConnectionTestResult): WebConnectionSummary {
    this.assertUser(userId);
    const normalized = this.normalizeConnection(input);
    const split = splitSecrets(normalized);
    const id = 'conn_' + randomBytes(12).toString('hex');
    const stored: StoredConnection = {
      id,
      userId,
      config: { ...split.config, id },
      encryptedSecrets: split.secrets ? this.vault.encrypt(JSON.stringify(split.secrets)) : undefined,
      status: testResult ? (testResult.ok ? 'ready' : 'unavailable') : 'unavailable',
      lastTestedAt: testResult ? new Date().toISOString() : undefined,
      tableCount: testResult?.tableCount,
      lastError: testResult?.error
    };
    this.connections.set(id, stored);
    const user = this.users.get(userId)!;
    if (!user.settings.activeConnectionId) user.settings.activeConnectionId = id;
    this.persist();
    return displayConnection(stored);
  }

  getConnectionSummary(userId: string, connectionId: string): WebConnectionSummary | null {
    const connection = this.connections.get(connectionId);
    return connection?.userId === userId ? displayConnection(connection) : null;
  }

  getConnectionConfig(userId: string, connectionId: string): ConnectionConfig | null {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId !== userId) return null;
    const secrets = connection.encryptedSecrets
      ? JSON.parse(this.vault.decrypt(connection.encryptedSecrets)) as ConnectionSecrets
      : {};
    return { ...connection.config, ...secrets, safetyLevel: 'safe' };
  }

  updateConnection(userId: string, connectionId: string, patch: Partial<ConnectionConfig>, testResult?: ConnectionTestResult): WebConnectionSummary {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId !== userId) throw new Error('Connection not found.');
    const existing = this.getConnectionConfig(userId, connectionId);
    if (!existing) throw new Error('Connection not found.');
    const merged = this.normalizeConnection({ ...existing, ...patch, id: connectionId, createdAt: existing.createdAt,
      elasticsearchUrl: patch.elasticsearchUrl === publicConnectionUri(existing.elasticsearchUrl)
        ? existing.elasticsearchUrl : patch.elasticsearchUrl ?? existing.elasticsearchUrl
    });
    const split = splitSecrets(merged);
    connection.config = { ...split.config, id: connectionId };
    connection.encryptedSecrets = split.secrets
      ? this.vault.encrypt(JSON.stringify(split.secrets))
      : connection.encryptedSecrets;
    connection.status = testResult ? (testResult.ok ? 'ready' : 'unavailable') : 'unavailable';
    connection.lastTestedAt = testResult ? new Date().toISOString() : undefined;
    connection.tableCount = testResult?.tableCount;
    connection.lastError = testResult?.error;
    this.persist();
    return displayConnection(connection);
  }

  deleteConnection(userId: string, connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId !== userId) return false;
    this.connections.delete(connectionId);
    const user = this.users.get(userId);
    if (user?.settings.activeConnectionId === connectionId) {
      const next = this.listConnections(userId)[0];
      user.settings.activeConnectionId = next?.id;
    }
    this.persist();
    return true;
  }

  markConnectionTest(userId: string, connectionId: string, result: ConnectionTestResult): WebConnectionSummary {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId !== userId) throw new Error('Connection not found.');
    connection.status = result.ok ? 'ready' : 'unavailable';
    connection.lastTestedAt = new Date().toISOString();
    connection.tableCount = result.tableCount;
    connection.lastError = result.error;
    this.persist();
    return displayConnection(connection);
  }

  hasUserKey(userId: string): boolean {
    return Boolean(this.users.get(userId)?.encryptedProviderKey);
  }

  setUserKey(userId: string, apiKey: string): void {
    const user = this.users.get(userId);
    if (!user) throw new Error('Account not found.');
    const value = apiKey.trim();
    if (!value || value.length < 10) throw new Error('Enter a valid provider key.');
    user.encryptedProviderKey = this.vault.encrypt(value);
    this.persist();
  }

  removeUserKey(userId: string): void {
    const user = this.users.get(userId);
    if (!user) throw new Error('Account not found.');
    user.encryptedProviderKey = undefined;
    this.persist();
  }

  resolveProviderKey(userId: string, internalKey?: string): { source: 'user' | 'internal' | 'none'; apiKey?: string; hasUserKey: boolean } {
    const user = this.users.get(userId);
    const hasUserKey = Boolean(user?.encryptedProviderKey);
    if (user?.encryptedProviderKey) {
      try {
        return { source: 'user', apiKey: this.vault.decrypt(user.encryptedProviderKey), hasUserKey };
      } catch {
        return { source: internalKey ? 'internal' : 'none', apiKey: internalKey, hasUserKey };
      }
    }
    return { source: internalKey ? 'internal' : 'none', apiKey: internalKey, hasUserKey };
  }

  private createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const idHash = this.sessionHash(token);
    const now = Date.now();
    const absoluteExpiresAt = now + this.sessionAbsoluteTtlMs;
    this.sessions.set(idHash, {
      idHash,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: Math.min(now + this.sessionTtlMs, absoluteExpiresAt),
      absoluteExpiresAt
    });
    this.persist();
    return token;
  }

  private sessionHash(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  }

  private load(): void {
    if (!this.storePath) return;
    let snapshot: AccountStoreSnapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as AccountStoreSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('The DB Chat account store could not be loaded.');
    }
    if (![1, 2].includes(snapshot.version) || !Array.isArray(snapshot.users) || !Array.isArray(snapshot.connections)) {
      throw new Error('The DB Chat account store has an unsupported format.');
    }
    for (const user of snapshot.users) {
      this.users.set(user.id, user);
      this.usersByEmail.set(normalizeEmail(user.email), user.id);
    }
    for (const connection of snapshot.connections) {
      // Older builds left newly saved connections in a "needs_test" state.
      // Treat those records as unavailable so the UI never asks users to
      // perform a redundant setup step after an upgrade.
      if (connection.status === 'needs_test') connection.status = 'unavailable';
      const oldSecrets = connection.encryptedSecrets
        ? JSON.parse(this.vault.decrypt(connection.encryptedSecrets)) as ConnectionSecrets : {};
      const split = splitSecrets({ ...connection.config, ...oldSecrets });
      connection.config = split.config;
      connection.encryptedSecrets = split.secrets ? this.vault.encrypt(JSON.stringify(split.secrets)) : undefined;
      this.connections.set(connection.id, connection);
    }
    for (const chat of snapshot.chats ?? []) {
      if (!chat.customTitle) chat.title = chatTitle(chat.messages);
      chat.messageCount = chat.messages.length;
      chat.artifactCount = chat.artifacts.length;
      this.chats.set(chat.id, chat);
    }
    const now = Date.now();
    for (const session of snapshot.sessions ?? []) {
      if (!session.revokedAt && session.expiresAt > now && session.absoluteExpiresAt > now) {
        this.sessions.set(session.idHash, session);
      }
    }
    this.persist();
  }

  private persist(): void {
    if (!this.storePath) return;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    const snapshot: AccountStoreSnapshot = {
      version: 2,
      users: [...this.users.values()],
      connections: [...this.connections.values()],
      chats: [...this.chats.values()],
      sessions: [...this.sessions.values()]
    };
    const temporaryPath = this.storePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, this.storePath);
  }

  private assertUser(userId: string): void {
    if (!this.users.has(userId)) throw new Error('Account not found.');
  }

  private defaultSettings(): WebAccountSettings {
    return {
      provider: 'openrouter',
      model: this.defaultModel,
      effortLevel: 'medium'
    };
  }

  private toUser(user: StoredUser): WebUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt
    };
  }

  private toPrincipal(user: StoredUser): Principal {
    return {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      roles: ['user']
    };
  }

  private normalizeConnection(input: ConnectionConfig): ConnectionConfig {
    if (!input.label?.trim()) throw new Error('Give this connection a name.');
    if (!['sqlite', 'postgres', 'mysql', 'mongodb', 'elasticsearch'].includes(input.kind)) {
      throw new Error('Choose a supported database type.');
    }
    if (input.kind === 'sqlite' && !input.databasePath?.trim() && !input.sqliteObjectKey) {
      throw new Error('Choose a SQLite database file.');
    }
    if (input.kind !== 'sqlite' && !input.host && !input.elasticsearchHost && !input.mongodbUri) {
      throw new Error('Enter a database host.');
    }
    return {
      ...input,
      label: input.label.trim(),
      createdAt: input.createdAt || new Date().toISOString(),
      safetyLevel: 'safe'
    };
  }
}
