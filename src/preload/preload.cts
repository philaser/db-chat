import type {
  ConnectionConfig,
  AgentEvent,
  DbChatApi,
  ModelChatMessage,
  ModelProviderKind,
  PersistedSettings
} from '../shared/types.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: DbChatApi = {
  chooseSqliteFile: () => ipcRenderer.invoke('dbchat:choose-sqlite-file'),
  connect: (config: ConnectionConfig) => ipcRenderer.invoke('dbchat:connect', config),
  getSchema: () => ipcRenderer.invoke('dbchat:get-schema'),
  executeQuery: (query: string) => ipcRenderer.invoke('dbchat:execute-query', query),
  sendChat: (messages: ModelChatMessage[], turnId?: string) => ipcRenderer.invoke('dbchat:send-chat', messages, turnId),
  subscribeToAgentEvents: (turnId: string, listener: (event: AgentEvent) => void) => {
    const channel = `dbchat:agent-event:${turnId}`;
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  abortChat: (turnId: string) => ipcRenderer.invoke('dbchat:abort-chat', turnId),
  loadSettings: () => ipcRenderer.invoke('dbchat:load-settings'),
  saveSettings: (settings: PersistedSettings) => ipcRenderer.invoke('dbchat:save-settings', settings),
  saveApiKey: (provider: ModelProviderKind, apiKey: string) => ipcRenderer.invoke('dbchat:save-api-key', provider, apiKey),
  listModels: () => ipcRenderer.invoke('dbchat:list-models'),
  listChatSessions: () => ipcRenderer.invoke('dbchat:list-chat-sessions'),
  saveChatSession: (session) => ipcRenderer.invoke('dbchat:save-chat-session', session),
  deleteChatSession: (id: string) => ipcRenderer.invoke('dbchat:delete-chat-session', id),
  clearChatSessions: () => ipcRenderer.invoke('dbchat:clear-chat-sessions'),
  listConnections: () => ipcRenderer.invoke('dbchat:list-connections'),
  deleteConnection: (id: string) => ipcRenderer.invoke('dbchat:delete-connection', id),
  saveCsvFile: (request) => ipcRenderer.invoke('dbchat:save-csv-file', request)
};

contextBridge.exposeInMainWorld('dbchat', api);
