import type {
  ConnectionConfig,
  DbChatApi,
  ModelProviderKind,
  PersistedSettings,
  QueryExecutionMode
} from '../shared/types.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: DbChatApi = {
  chooseSqliteFile: () => ipcRenderer.invoke('dbchat:choose-sqlite-file'),
  connect: (config: ConnectionConfig) => ipcRenderer.invoke('dbchat:connect', config),
  getSchema: () => ipcRenderer.invoke('dbchat:get-schema'),
  validateQuery: (query: string, mode: QueryExecutionMode) => ipcRenderer.invoke('dbchat:validate-query', query, mode),
  executeQuery: (query: string) => ipcRenderer.invoke('dbchat:execute-query', query),
  sendChat: (prompt: string) => ipcRenderer.invoke('dbchat:send-chat', prompt),
  loadSettings: () => ipcRenderer.invoke('dbchat:load-settings'),
  saveSettings: (settings: PersistedSettings) => ipcRenderer.invoke('dbchat:save-settings', settings),
  saveApiKey: (provider: ModelProviderKind, apiKey: string) => ipcRenderer.invoke('dbchat:save-api-key', provider, apiKey),
  listModels: (provider: ModelProviderKind) => ipcRenderer.invoke('dbchat:list-models', provider)
};

contextBridge.exposeInMainWorld('dbchat', api);
