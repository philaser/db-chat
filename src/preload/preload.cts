import type {
  ConnectionConfig,
  ChatProgressEvent,
  DbChatApi,
  ModelChatMessage,
  ModelProviderKind,
  PersistedSettings,
  QueryExecutionMode
} from '../shared/types.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

function logActivityDebug(message: string, detail?: unknown) {
  if (process.env.DBCHAT_ACTIVITY_DEBUG === '1') {
    console.log(`[dbchat:activity:preload] ${message}`, detail);
  }
}

const api: DbChatApi = {
  chooseSqliteFile: () => ipcRenderer.invoke('dbchat:choose-sqlite-file'),
  connect: (config: ConnectionConfig) => ipcRenderer.invoke('dbchat:connect', config),
  getSchema: () => ipcRenderer.invoke('dbchat:get-schema'),
  validateQuery: (query: string, mode: QueryExecutionMode) => ipcRenderer.invoke('dbchat:validate-query', query, mode),
  executeQuery: (query: string, mode: QueryExecutionMode) => ipcRenderer.invoke('dbchat:execute-query', query, mode),
  sendChat: (messages: ModelChatMessage[], turnId?: string) => ipcRenderer.invoke('dbchat:send-chat', messages, turnId),
  onChatProgress: (turnId: string, listener: (event: ChatProgressEvent) => void) => {
    const channel = `dbchat:chat-progress:${turnId}`;
    logActivityDebug('subscribe', { turnId, channel });
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ChatProgressEvent) => {
      logActivityDebug('event', {
        channel,
        turnId,
        payloadTurnId: payload.turnId,
        stepId: payload.step?.id,
        queryId: payload.step?.queryId,
        status: payload.step?.status,
        title: payload.step?.title
      });
      listener(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      logActivityDebug('unsubscribe', { turnId, channel });
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  loadSettings: () => ipcRenderer.invoke('dbchat:load-settings'),
  saveSettings: (settings: PersistedSettings) => ipcRenderer.invoke('dbchat:save-settings', settings),
  saveApiKey: (provider: ModelProviderKind, apiKey: string) => ipcRenderer.invoke('dbchat:save-api-key', provider, apiKey),
  listModels: (provider: ModelProviderKind) => ipcRenderer.invoke('dbchat:list-models', provider),
  listChatSessions: () => ipcRenderer.invoke('dbchat:list-chat-sessions'),
  saveChatSession: (session) => ipcRenderer.invoke('dbchat:save-chat-session', session),
  deleteChatSession: (id: string) => ipcRenderer.invoke('dbchat:delete-chat-session', id),
  clearChatSessions: () => ipcRenderer.invoke('dbchat:clear-chat-sessions'),
  listConnections: () => ipcRenderer.invoke('dbchat:list-connections'),
  deleteConnection: (id: string) => ipcRenderer.invoke('dbchat:delete-connection', id)
};

contextBridge.exposeInMainWorld('dbchat', api);
