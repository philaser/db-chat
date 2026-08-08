import { BrowserWindow, dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AuditEntry,
  ConnectionConfig,
  ConnectionHistoryItem,
  DatabaseConnector,
  DatabaseSchema,
  ModelChatMessage,
  ModelProviderKind,
  PersistedChatSession,
  PersistedSettings,
  QueryResult,
  SafetyLevel
} from '../shared/types.js';
import type { OpenDialogOptions } from 'electron';
import { ElasticsearchConnector } from './connectors/ElasticsearchConnector.js';
import { MongoDBConnector } from './connectors/MongoDBConnector.js';
import { MySQLConnector } from './connectors/MySQLConnector.js';
import { PostgresConnector } from './connectors/PostgresConnector.js';
import { SQLiteConnector } from './connectors/SQLiteConnector.js';
import { runAgentLoop } from './agent/AgentLoop.js';
import { PermissionManager } from './agent/PermissionManager.js';
import { ApprovalManager } from './agent/ApprovalManager.js';
import { createToolRegistry } from './agent/tools/index.js';
import { MemoryStore } from './agent/MemoryStore.js';
import { OpenRouterClient } from './model/OpenRouterClient.js';
import { AppStore } from './storage/AppStore.js';
import { AuditStore } from './storage/AuditStore.js';

export class IpcController {
  private connector: DatabaseConnector | null = null;
  private schema: DatabaseSchema | null = null;
  private toolRegistry = createToolRegistry();
  private memoryStore = new MemoryStore();
  private permissionManager = new PermissionManager();
  private approvalManager = new ApprovalManager();
  private auditStore = new AuditStore();
  private activeAbortController: AbortController | null = null;
  private currentConnectionId: string | null = null;

  constructor(private readonly store: AppStore) {
    this.loadMemories();
  }

  getConnector(): DatabaseConnector | null {
    return this.connector;
  }

  getConnectionId(): string {
    return this.currentConnectionId ?? 'unknown';
  }

  async refreshSchema(): Promise<DatabaseSchema | null> {
    if (!this.connector) return null;
    this.schema = await this.connector.introspect();
    return this.schema;
  }

  async chooseSqliteFile(): Promise<ConnectionConfig | null> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const dialogOptions: OpenDialogOptions = {
      title: 'Choose SQLite Database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) {
      return null;
    }

    return {
      id: crypto.randomUUID(),
      kind: 'sqlite',
      label: path.basename(filePath),
      databasePath: filePath,
      createdAt: new Date().toISOString()
    };
  }

  async connect(config: ConnectionConfig): Promise<DatabaseSchema> {
    const hydratedConfig = this.store.hydrateConnectionSecrets(config);
    this.connector?.close();
    const connector = createConnector(hydratedConfig.kind);
    await connector.connect(hydratedConfig);
    this.connector = connector;
    this.currentConnectionId = hydratedConfig.id;
    this.schema = await connector.introspect();
    this.store.saveConnection(hydratedConfig);
    return this.schema;
  }

  async getSchema(): Promise<DatabaseSchema | null> {
    return this.schema;
  }

  async sendChat(
    messages: ModelChatMessage[],
    turnId?: string,
    webContents?: WebContents
  ) {
    const settings = this.store.loadSettings();
    const apiKey = this.store.getApiKey(settings.provider);
    const id = turnId ?? crypto.randomUUID();

    console.log(`[dbchat:main] sendChat turn=${id}, model=${settings.model}, effort=${settings.effortLevel}, messages=${messages.length}`);

    if (!apiKey) {
      console.log('[dbchat:main] sendChat: no API key, returning placeholder');
      return {
        message: {
          id: `msg-${id}`,
          role: 'assistant' as const,
          content: 'Add your OpenRouter API key in Settings to start chatting with DB Chat.',
          createdAt: new Date().toISOString()
        }
      };
    }

    const client = new OpenRouterClient({ apiKey });

    const result = await runAgentLoop(messages, id, webContents, {
      model: settings.model || 'openai/gpt-4.1-mini',
      client,
      controller: this,
      memoryStore: this.memoryStore,
      toolRegistry: this.toolRegistry,
      permissionManager: this.permissionManager,
      approvalManager: this.approvalManager
    });

    this.persistMemories();

    return {
      message: result.message,
      events: result.events
    };
  }

  abortChat(): void {
    // Abort signal handled via AbortController in AgentLoop
  }

  approveInterruption(turnId: string, interruptionId: string): void {
    this.approvalManager.approve(interruptionId);
  }

  denyInterruption(turnId: string, interruptionId: string): void {
    this.approvalManager.deny(interruptionId);
  }

  loadSettings(): PersistedSettings & { hasApiKey: boolean } {
    const settings = this.store.loadSettings();
    return {
      ...settings,
      hasApiKey: this.store.hasApiKey(settings.provider)
    };
  }

  saveSettings(settings: PersistedSettings): void {
    this.store.saveSettings(settings);
  }

  saveApiKey(provider: ModelProviderKind, apiKey: string): void {
    this.store.saveApiKey(provider, apiKey);
  }

  async listModels() {
    const settings = this.store.loadSettings();
    const apiKey = this.store.getApiKey(settings.provider);
    if (!apiKey) {
      return [
        { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
      ];
    }
    try {
      const client = new OpenRouterClient({ apiKey });
      return client.listModels();
    } catch {
      return [
        { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' },
        { id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
      ];
    }
  }

  listChatSessions(): PersistedChatSession[] {
    return this.store.listChatSessions();
  }

  saveChatSession(session: PersistedChatSession): PersistedChatSession {
    return this.store.saveChatSession(session);
  }

  deleteChatSession(id: string): void {
    this.store.deleteChatSession(id);
  }

  clearChatSessions(): void {
    this.store.clearChatSessions();
  }

  listConnections(): ConnectionHistoryItem[] {
    return this.store.listConnections();
  }

  deleteConnection(id: string): void {
    this.store.deleteConnection(id);
  }

  renameConnection(id: string, label: string): void {
    this.store.renameConnection(id, label);
  }

  setSafetyLevel(_connectionId: string, level: SafetyLevel): void {
    console.log(`[dbchat:main] setSafetyLevel connection=${_connectionId}, level=${level}`);
    if (this.connector) {
      this.connector.setSafetyLevel(level);
    }
    this.permissionManager?.setSafetyLevel(level);
    console.log(`[dbchat:main] setSafetyLevel done`);
  }

  getAuditLog(): unknown[] {
    return this.auditStore.getEntries(200);
  }

  audit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    this.auditStore.log(entry);
  }

  requireConnector(): DatabaseConnector {
    if (!this.connector) {
      throw new Error('No database is connected.');
    }
    return this.connector;
  }

  getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  private persistMemories(): void {
    try {
      this.store.persistMemories?.(this.memoryStore.toJSON());
    } catch {
      // Non-critical — memories are best-effort
    }
  }

  private loadMemories(): void {
    try {
      const data = this.store.loadMemories?.();
      if (data) {
        this.memoryStore.fromJSON(data);
      }
    } catch {
      // Non-critical
    }
  }

  async saveCsvFile(request: { content: string; defaultName: string }): Promise<void> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(window, {
      title: 'Export CSV',
      defaultPath: request.defaultName,
      filters: [
        { name: 'CSV files', extensions: ['csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) {
      return;
    }
    await fs.promises.writeFile(result.filePath, request.content, 'utf-8');
  }
}

function createConnector(kind: string): DatabaseConnector {
  switch (kind) {
    case 'elasticsearch':
      return new ElasticsearchConnector();
    case 'mysql':
      return new MySQLConnector();
    case 'postgres':
      return new PostgresConnector();
    case 'mongodb':
      return new MongoDBConnector();
    case 'sqlite':
      return new SQLiteConnector();
    default:
      throw new Error(`Unsupported database kind: ${kind}`);
  }
}
