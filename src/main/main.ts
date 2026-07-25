import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from './storage/AppStore.js';
import { IpcController } from './ipc.js';
import type { ConnectionConfig, ModelProviderKind, PersistedChatSession, PersistedSettings } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.VITE_DEV_SERVER_URL || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'DB Chat',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
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
  ipcMain.handle('dbchat:execute-query', (_event, query: string) => {
    return controller.requireConnector().executeQuery(query);
  });
  ipcMain.handle('dbchat:send-chat', (event, messages, turnId?: string) => controller.sendChat(messages, turnId, event.sender));
  ipcMain.handle('dbchat:abort-chat', () => controller.abortChat());
  ipcMain.handle('dbchat:load-settings', () => controller.loadSettings());
  ipcMain.handle('dbchat:save-settings', (_event, settings: PersistedSettings) => controller.saveSettings(settings));
  ipcMain.handle('dbchat:save-api-key', (_event, provider: ModelProviderKind, apiKey: string) => controller.saveApiKey(provider, apiKey));
  ipcMain.handle('dbchat:list-models', () => controller.listModels());
  ipcMain.handle('dbchat:list-chat-sessions', () => controller.listChatSessions());
  ipcMain.handle('dbchat:save-chat-session', (_event, session: PersistedChatSession) => controller.saveChatSession(session));
  ipcMain.handle('dbchat:delete-chat-session', (_event, id: string) => controller.deleteChatSession(id));
  ipcMain.handle('dbchat:clear-chat-sessions', () => controller.clearChatSessions());
  ipcMain.handle('dbchat:list-connections', () => controller.listConnections());
  ipcMain.handle('dbchat:delete-connection', (_event, id: string) => controller.deleteConnection(id));
  ipcMain.handle('dbchat:rename-connection', (_event, id: string, label: string) => controller.renameConnection(id, label));
  ipcMain.handle('dbchat:save-csv-file', (_event, request: { content: string; defaultName: string }) => controller.saveCsvFile(request));
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
