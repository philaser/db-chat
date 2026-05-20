import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from './storage/AppStore.js';
import { IpcController } from './ipc.js';
import type { ConnectionConfig, ModelProviderKind, PersistedChatSession, PersistedSettings, QueryExecutionMode } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'DB Chat',
    backgroundColor: '#f7f4ed',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'));
  }
}

function registerIpc(): void {
  const controller = new IpcController(new AppStore());

  ipcMain.handle('dbchat:choose-sqlite-file', () => controller.chooseSqliteFile());
  ipcMain.handle('dbchat:connect', (_event, config: ConnectionConfig) => controller.connect(config));
  ipcMain.handle('dbchat:get-schema', () => controller.getSchema());
  ipcMain.handle('dbchat:validate-query', (_event, query: string, mode: QueryExecutionMode) => {
    return controller.requireConnector().validateQuery(query, mode);
  });
  ipcMain.handle('dbchat:execute-query', (_event, query: string) => {
    return controller.requireConnector().executeQuery(query);
  });
  ipcMain.handle('dbchat:send-chat', (_event, messages) => controller.sendChat(messages));
  ipcMain.handle('dbchat:load-settings', () => controller.loadSettings());
  ipcMain.handle('dbchat:save-settings', (_event, settings: PersistedSettings) => controller.saveSettings(settings));
  ipcMain.handle('dbchat:save-api-key', (_event, provider: ModelProviderKind, apiKey: string) => controller.saveApiKey(provider, apiKey));
  ipcMain.handle('dbchat:list-models', (_event, provider: ModelProviderKind) => controller.listModels(provider));
  ipcMain.handle('dbchat:list-chat-sessions', () => controller.listChatSessions());
  ipcMain.handle('dbchat:save-chat-session', (_event, session: PersistedChatSession) => controller.saveChatSession(session));
  ipcMain.handle('dbchat:delete-chat-session', (_event, id: string) => controller.deleteChatSession(id));
  ipcMain.handle('dbchat:list-connections', () => controller.listConnections());
  ipcMain.handle('dbchat:delete-connection', (_event, id: string) => controller.deleteConnection(id));
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
