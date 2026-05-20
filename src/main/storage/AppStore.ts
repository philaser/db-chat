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

  saveConnection(config: ConnectionConfig): ConnectionHistoryItem {
    const data = this.read();
    const saved = this.normalizeConnection({
      ...config,
      lastConnectedAt: new Date().toISOString()
    });
    const connections = [
      saved,
      ...data.connections.filter((connection) => connection.id !== saved.id && connection.databasePath !== saved.databasePath)
    ].slice(0, 20);
    this.write({ ...data, connections });
    return saved;
  }

  deleteConnection(id: string): void {
    const data = this.read();
    this.write({
      ...data,
      connections: data.connections.filter((connection) => connection.id !== id),
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
    const saved = this.normalizeChatSession(session);
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
      return {
        settings: this.normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed.settings }),
        encryptedApiKeys: parsed.encryptedApiKeys ?? {},
        connections: (parsed.connections ?? []).map((connection) => this.normalizeConnection(connection)).filter(Boolean),
        chatSessions: (parsed.chatSessions ?? []).map((session) => this.normalizeChatSession(session)).filter(Boolean)
      };
    } catch {
      return {
        settings: DEFAULT_SETTINGS,
        encryptedApiKeys: {},
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
    return {
      id: connection.id || crypto.randomUUID(),
      kind: connection.kind === 'sqlite' ? 'sqlite' : 'sqlite',
      label: connection.label || 'SQLite database',
      databasePath: connection.databasePath,
      createdAt,
      lastConnectedAt: connection.lastConnectedAt ?? createdAt
    };
  }

  private normalizeChatSession(session: Partial<PersistedChatSession>): PersistedChatSession {
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

  private decrypt(value: string): string {
    const [prefix, payload] = value.split(':', 2);
    if (prefix === 'safe') {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'));
    }
    return Buffer.from(payload, 'base64').toString('utf8');
  }
}
