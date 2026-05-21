import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ConnectionConfig,
  ConnectionHistoryItem,
  ModelProviderKind,
  PersistedChatSession,
  PersistedSettings
} from '../../shared/types.js';
import { normalizeApiKey } from '../model/apiKeys.js';

interface StoreData {
  settings: PersistedSettings;
  encryptedApiKeys: Partial<Record<ModelProviderKind, string>>;
  encryptedElasticsearchPasswords: Record<string, string>;
  connections: ConnectionHistoryItem[];
  chatSessions: PersistedChatSession[];
}

const DEFAULT_SETTINGS: PersistedSettings = {
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  safeMode: true
};

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
    if (config.kind !== 'elasticsearch' || config.elasticsearchPassword) {
      return config;
    }

    const encrypted = this.read().encryptedElasticsearchPasswords[config.id];
    return encrypted ? { ...config, elasticsearchPassword: this.decrypt(encrypted) } : config;
  }

  saveConnection(config: ConnectionConfig): ConnectionHistoryItem {
    const data = this.read();
    const normalized = this.normalizeConnection({
      ...config,
      lastConnectedAt: new Date().toISOString()
    });
    const shouldRememberPassword = normalized.kind === 'elasticsearch'
      && Boolean(config.elasticsearchRememberPassword && config.elasticsearchPassword);
    const saved: ConnectionHistoryItem = {
      ...normalized,
      elasticsearchRememberPassword: shouldRememberPassword,
      elasticsearchHasSavedPassword: shouldRememberPassword
    };
    const connections = [
      saved,
      ...data.connections.filter((connection) => {
        const sameId = connection.id === saved.id;
        const sameSqlitePath = saved.kind === 'sqlite' && connection.databasePath === saved.databasePath;
        const sameElasticsearchHost = saved.kind === 'elasticsearch'
          && elasticsearchKey(connection) === elasticsearchKey(saved);
        return !sameId && !sameSqlitePath && !sameElasticsearchHost;
      })
    ].slice(0, 20);
    const retainedConnectionIds = new Set(connections.map((connection) => connection.id));
    const encryptedElasticsearchPasswords = Object.fromEntries(
      Object.entries(data.encryptedElasticsearchPasswords)
        .filter(([id]) => retainedConnectionIds.has(id) && id !== saved.id)
    );
    if (shouldRememberPassword && config.elasticsearchPassword) {
      encryptedElasticsearchPasswords[saved.id] = this.encryptWithSafeStorage(config.elasticsearchPassword);
    }
    this.write({ ...data, connections, encryptedElasticsearchPasswords });
    return saved;
  }

  deleteConnection(id: string): void {
    const data = this.read();
    this.write({
      ...data,
      connections: data.connections.filter((connection) => connection.id !== id),
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
    const saved = this.normalizeChatSession(session, data.encryptedElasticsearchPasswords);
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
      return {
        settings: this.normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }),
        encryptedApiKeys: parsed.encryptedApiKeys ?? {},
        encryptedElasticsearchPasswords,
        connections: (parsed.connections ?? []).map((connection) => this.normalizeConnection({
          ...connection,
          elasticsearchHasSavedPassword: Boolean(connection.id && encryptedElasticsearchPasswords[connection.id])
        })).filter(Boolean),
        chatSessions: (parsed.chatSessions ?? []).map((session) => this.normalizeChatSession(session, encryptedElasticsearchPasswords)).filter(Boolean)
      };
    } catch {
      return {
        settings: DEFAULT_SETTINGS,
        encryptedApiKeys: {},
        encryptedElasticsearchPasswords: {},
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
    const kind = connection.kind === 'elasticsearch' ? 'elasticsearch' : 'sqlite';
    return {
      id: connection.id || crypto.randomUUID(),
      kind,
      label: connection.label || (kind === 'elasticsearch' ? 'Elasticsearch cluster' : 'SQLite database'),
      databasePath: kind === 'sqlite' ? connection.databasePath : undefined,
      elasticsearchUrl: kind === 'elasticsearch' ? connection.elasticsearchUrl : undefined,
      elasticsearchHost: kind === 'elasticsearch' ? connection.elasticsearchHost : undefined,
      elasticsearchPort: kind === 'elasticsearch' ? connection.elasticsearchPort : undefined,
      elasticsearchUseSsl: kind === 'elasticsearch' ? connection.elasticsearchUseSsl : undefined,
      elasticsearchVerifyCerts: kind === 'elasticsearch' ? connection.elasticsearchVerifyCerts : undefined,
      elasticsearchUsername: kind === 'elasticsearch' ? connection.elasticsearchUsername : undefined,
      elasticsearchRememberPassword: kind === 'elasticsearch' ? connection.elasticsearchRememberPassword : undefined,
      elasticsearchHasSavedPassword: kind === 'elasticsearch' ? connection.elasticsearchHasSavedPassword : undefined,
      createdAt,
      lastConnectedAt: connection.lastConnectedAt ?? createdAt
    };
  }

  private normalizeChatSession(
    session: Partial<PersistedChatSession>,
    encryptedElasticsearchPasswords: Record<string, string> = {}
  ): PersistedChatSession {
    const createdAt = session.createdAt ?? new Date().toISOString();
    const messages = (session.messages ?? []).filter((message) => (
      message && (message.role === 'user' || message.role === 'assistant' || message.role === 'system') && typeof message.content === 'string'
    ));
    return {
      id: session.id || crypto.randomUUID(),
      title: session.title?.trim() || 'Untitled chat',
      messages,
      connection: session.connection ? this.normalizeConnection({
        ...session.connection,
        elasticsearchHasSavedPassword: Boolean(
          session.connection.id && encryptedElasticsearchPasswords[session.connection.id]
        ),
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
      throw new Error('Secure storage is unavailable. DB Chat cannot remember this Elasticsearch password.');
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
