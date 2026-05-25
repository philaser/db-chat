import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionConfig,
  ConnectionHistoryItem,
  DatabaseKind,
  ModelProviderKind,
  PersistedChatSession,
  PersistedSettings
} from '../../shared/types.js';
import { normalizeApiKey } from '../model/apiKeys.js';

interface StoreData {
  settings: PersistedSettings;
  encryptedApiKeys: Partial<Record<ModelProviderKind, string>>;
  encryptedElasticsearchPasswords: Record<string, string>;
  encryptedPasswords: Record<string, string>;
  connections: ConnectionHistoryItem[];
  chatSessions: PersistedChatSession[];
}

const DEFAULT_SETTINGS: PersistedSettings = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  safeMode: true
};

const PASSWORD_KINDS: Set<DatabaseKind> = new Set(['elasticsearch', 'mysql', 'postgres', 'mongodb']);

export class AppStore {
  private readonly filePath: string;

  constructor(filePath = path.join(app.getPath('userData'), 'db-chat-store.json')) {
    this.filePath = filePath;
  }

  loadSettings(): PersistedSettings {
    return this.read().settings;
  }

  saveSettings(settings: PersistedSettings): void {
    const data = this.read();
    this.write({ ...data, settings: this.normalizeSettings(settings) });
  }

  saveApiKey(provider: ModelProviderKind, apiKey: string): void {
    const data = this.read();
    const encryptedApiKeys = {
      ...data.encryptedApiKeys,
      [provider]: this.encrypt(normalizeApiKey(apiKey))
    };
    this.write({ ...data, encryptedApiKeys });
  }

  getApiKey(provider: ModelProviderKind): string | null {
    const encrypted = this.read().encryptedApiKeys[provider];
    if (!encrypted) {
      return null;
    }
    return this.decrypt(encrypted);
  }

  hasApiKey(provider: ModelProviderKind): boolean {
    return Boolean(this.read().encryptedApiKeys[provider]);
  }

  listConnections(): ConnectionHistoryItem[] {
    return this.read().connections;
  }

  hydrateConnectionSecrets(config: ConnectionConfig): ConnectionConfig {
    if (!PASSWORD_KINDS.has(config.kind)) {
      return config;
    }

    if (config.kind === 'elasticsearch') {
      if (config.elasticsearchPassword) {
        return config;
      }
      const data = this.read();
      const encrypted = data.encryptedPasswords[config.id] ?? data.encryptedElasticsearchPasswords[config.id];
      return encrypted ? { ...config, elasticsearchPassword: this.decrypt(encrypted) } : config;
    }

    if (config.password) {
      return config;
    }

    const encrypted = this.read().encryptedPasswords[config.id];
    return encrypted ? { ...config, password: this.decrypt(encrypted) } : config;
  }

  saveConnection(config: ConnectionConfig): ConnectionHistoryItem {
    const data = this.read();
    const normalized = this.normalizeConnection({
      ...config,
      lastConnectedAt: new Date().toISOString()
    });

    const shouldRememberPassword = PASSWORD_KINDS.has(normalized.kind)
      && Boolean(
        (normalized.kind === 'elasticsearch'
          ? config.elasticsearchRememberPassword && config.elasticsearchPassword
          : config.rememberPassword && config.password)
      );

    const saved: ConnectionHistoryItem = {
      ...normalized,
      ...(normalized.kind === 'elasticsearch'
        ? {
          elasticsearchRememberPassword: shouldRememberPassword,
          elasticsearchHasSavedPassword: shouldRememberPassword
        }
        : {
          rememberPassword: shouldRememberPassword,
          hasSavedPassword: shouldRememberPassword
        })
    };

    const connections = [
      saved,
      ...data.connections.filter((connection) => {
        const sameId = connection.id === saved.id;
        const sameSqlitePath = saved.kind === 'sqlite' && connection.databasePath === saved.databasePath;
        const sameElasticsearchHost = saved.kind === 'elasticsearch'
          && elasticsearchKey(connection) === elasticsearchKey(saved);
        const sameRelationalHost = (saved.kind === 'mysql' || saved.kind === 'postgres' || saved.kind === 'mongodb')
          && relationalKey(connection) === relationalKey(saved);
        return !sameId && !sameSqlitePath && !sameElasticsearchHost && !sameRelationalHost;
      })
    ].slice(0, 20);

    const retainedConnectionIds = new Set(connections.map((connection) => connection.id));
    const encryptedPasswords = Object.fromEntries(
      Object.entries(data.encryptedPasswords)
        .filter(([id]) => retainedConnectionIds.has(id) && id !== saved.id)
    );

    if (shouldRememberPassword) {
      const savedPassword = saved.kind === 'elasticsearch'
        ? config.elasticsearchPassword
        : config.password;
      if (savedPassword) {
        encryptedPasswords[saved.id] = this.encryptWithSafeStorage(savedPassword);
      }
    }

    this.write({
      ...data,
      connections,
      encryptedPasswords,
      encryptedElasticsearchPasswords: Object.keys(data.encryptedElasticsearchPasswords).length
        ? {} : data.encryptedElasticsearchPasswords
    });
    return saved;
  }

  deleteConnection(id: string): void {
    const data = this.read();
    this.write({
      ...data,
      connections: data.connections.filter((connection) => connection.id !== id),
      encryptedPasswords: Object.fromEntries(
        Object.entries(data.encryptedPasswords).filter(([connectionId]) => connectionId !== id)
      ),
      encryptedElasticsearchPasswords: Object.fromEntries(
        Object.entries(data.encryptedElasticsearchPasswords).filter(([connectionId]) => connectionId !== id)
      ),
      chatSessions: data.chatSessions.map((session) => (
        session.connection?.id === id ? { ...session, connection: undefined } : session
      ))
    });
  }

  listChatSessions(): PersistedChatSession[] {
    return this.read().chatSessions;
  }

  saveChatSession(session: PersistedChatSession): PersistedChatSession {
    const data = this.read();
    const saved = this.normalizeChatSession(session, data.encryptedPasswords, data.encryptedElasticsearchPasswords);
    const chatSessions = [
      saved,
      ...data.chatSessions.filter((item) => item.id !== saved.id)
    ].slice(0, 50);
    this.write({ ...data, chatSessions });
    return saved;
  }

  deleteChatSession(id: string): void {
    const data = this.read();
    this.write({
      ...data,
      chatSessions: data.chatSessions.filter((session) => session.id !== id)
    });
  }

  private read(): StoreData {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      const encryptedElasticsearchPasswords = parsed.encryptedElasticsearchPasswords ?? {};
      const encryptedPasswords: Record<string, string> = {
        ...encryptedElasticsearchPasswords,
        ...parsed.encryptedPasswords ?? {}
      };
      return {
        settings: this.normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }),
        encryptedApiKeys: parsed.encryptedApiKeys ?? {},
        encryptedElasticsearchPasswords,
        encryptedPasswords,
        connections: (parsed.connections ?? []).map((connection) => this.normalizeConnection({
          ...connection,
          ...(connection.kind === 'elasticsearch'
            ? { elasticsearchHasSavedPassword: Boolean(connection.id && encryptedPasswords[connection.id]) }
            : { hasSavedPassword: Boolean(connection.id && encryptedPasswords[connection.id]) })
        })).filter(Boolean),
        chatSessions: (parsed.chatSessions ?? []).map((session) => this.normalizeChatSession(session, encryptedPasswords, encryptedElasticsearchPasswords)).filter(Boolean)
      };
    } catch {
      return {
        settings: DEFAULT_SETTINGS,
        encryptedApiKeys: {},
        encryptedElasticsearchPasswords: {},
        encryptedPasswords: {},
        connections: [],
        chatSessions: []
      };
    }
  }

  private write(data: StoreData): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private normalizeSettings(settings: PersistedSettings): PersistedSettings {
    return {
      provider: settings.provider,
      model: settings.model,
      safeMode: settings.safeMode
    };
  }

  private normalizeConnection(connection: Partial<ConnectionHistoryItem>): ConnectionHistoryItem {
    const createdAt = connection.createdAt ?? new Date().toISOString();
    const kind: DatabaseKind = PASSWORD_KINDS.has(connection.kind as DatabaseKind) || connection.kind === 'sqlite'
      ? (connection.kind as DatabaseKind)
      : 'sqlite';
    const isPasswordKind = PASSWORD_KINDS.has(kind);

    return {
      id: connection.id || crypto.randomUUID(),
      kind,
      label: connection.label || kindLabel(kind),
      databasePath: kind === 'sqlite' ? connection.databasePath : undefined,
      elasticsearchUrl: kind === 'elasticsearch' ? connection.elasticsearchUrl : undefined,
      elasticsearchHost: kind === 'elasticsearch' ? connection.elasticsearchHost : undefined,
      elasticsearchPort: kind === 'elasticsearch' ? connection.elasticsearchPort : undefined,
      elasticsearchUseSsl: kind === 'elasticsearch' ? connection.elasticsearchUseSsl : undefined,
      elasticsearchVerifyCerts: kind === 'elasticsearch' ? connection.elasticsearchVerifyCerts : undefined,
      elasticsearchUsername: kind === 'elasticsearch' ? connection.elasticsearchUsername : undefined,
      elasticsearchRememberPassword: kind === 'elasticsearch' ? connection.elasticsearchRememberPassword : undefined,
      elasticsearchHasSavedPassword: kind === 'elasticsearch' ? connection.elasticsearchHasSavedPassword : undefined,
      host: isPasswordKind && kind !== 'elasticsearch' ? connection.host : undefined,
      port: isPasswordKind && kind !== 'elasticsearch' ? connection.port : undefined,
      database: isPasswordKind && kind !== 'elasticsearch' ? connection.database : undefined,
      username: isPasswordKind && kind !== 'elasticsearch' ? connection.username : undefined,
      ssl: isPasswordKind && kind !== 'elasticsearch' ? connection.ssl : undefined,
      rememberPassword: isPasswordKind && kind !== 'elasticsearch' ? connection.rememberPassword : undefined,
      hasSavedPassword: isPasswordKind && kind !== 'elasticsearch' ? connection.hasSavedPassword : undefined,
      authDatabase: kind === 'mongodb' ? connection.authDatabase : undefined,
      mongodbUri: kind === 'mongodb' ? connection.mongodbUri : undefined,
      createdAt,
      lastConnectedAt: connection.lastConnectedAt ?? createdAt
    };
  }

  private normalizeChatSession(
    session: Partial<PersistedChatSession>,
    encryptedPasswords: Record<string, string> = {},
    encryptedElasticsearchPasswords: Record<string, string> = {}
  ): PersistedChatSession {
    const createdAt = session.createdAt ?? new Date().toISOString();
    const messages = (session.messages ?? []).filter((message) => (
      message && (message.role === 'user' || message.role === 'assistant' || message.role === 'system') && typeof message.content === 'string'
    ));
    const allPasswords = { ...encryptedElasticsearchPasswords, ...encryptedPasswords };
    return {
      id: session.id || crypto.randomUUID(),
      title: session.title?.trim() || 'Untitled chat',
      messages,
      connection: session.connection ? this.normalizeConnection({
        ...session.connection,
        ...(session.connection.kind === 'elasticsearch'
          ? { elasticsearchHasSavedPassword: Boolean(
            session.connection.id && allPasswords[session.connection.id]
          ) }
          : { hasSavedPassword: Boolean(
            session.connection.id && allPasswords[session.connection.id]
          ) }),
        lastConnectedAt: session.connection.createdAt
      }) : undefined,
      query: session.query,
      result: session.result,
      createdAt,
      updatedAt: session.updatedAt ?? createdAt
    };
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString('base64')}`;
    }
    return `plain:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  private encryptWithSafeStorage(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable. DB Chat cannot remember this password.');
    }
    return `safe:${safeStorage.encryptString(value).toString('base64')}`;
  }

  private decrypt(value: string): string {
    const [prefix, payload] = value.split(':', 2);
    if (prefix === 'safe') {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'));
    }
    return Buffer.from(payload, 'base64').toString('utf8');
  }
}

function kindLabel(kind: DatabaseKind): string {
  switch (kind) {
    case 'elasticsearch': return 'Elasticsearch cluster';
    case 'mysql': return 'MySQL database';
    case 'postgres': return 'PostgreSQL database';
    case 'mongodb': return 'MongoDB database';
    default: return 'SQLite database';
  }
}

function elasticsearchKey(connection: Partial<ConnectionConfig>): string {
  if (connection.elasticsearchHost) {
    return [
      connection.elasticsearchUseSsl ? 'https' : 'http',
      connection.elasticsearchHost,
      String(connection.elasticsearchPort ?? 9200)
    ].join(':');
  }
  return connection.elasticsearchUrl ?? '';
}

function relationalKey(connection: Partial<ConnectionConfig>): string {
  return [
    connection.kind ?? '',
    connection.host ?? '',
    String(connection.port ?? ''),
    connection.database ?? ''
  ].join(':');
}
