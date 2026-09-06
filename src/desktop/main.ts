import { app, BrowserWindow, Menu, shell } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applicationUrl, isApplicationNavigation, isExternalLink } from './navigation.js';

let window: BrowserWindow | null = null;
let hostedUrl: URL | null = null;

function configuredUrl(): URL {
  const packaged = JSON.parse(readFileSync(path.join(app.getAppPath(), 'application.json'), 'utf8')) as { url?: string };
  const value = process.env.DBCHAT_DESKTOP_URL || packaged.url;
  if (!value) throw new Error('The desktop application URL has not been configured.');
  return applicationUrl(value, !app.isPackaged);
}

function showConnectionError(message: string): void {
  const safe = message.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  // No scripts, local file access, IPC or secrets are exposed to this page.
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>DB Chat</title><style>body{font:16px system-ui;margin:64px;line-height:1.6;color:#232323}a{color:#315fc7}</style></head><body><h1>Unable to open DB Chat</h1><p>${safe}</p>${hostedUrl ? `<a href="${hostedUrl.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Try again</a>` : '<p>Ask the application publisher to configure its hosted web address.</p>'}</body></html>`;
  void window?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 600, minHeight: 500,
    title: 'DB Chat', backgroundColor: '#fbfaf7',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  const contents = window.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  const navigate = (event: Electron.Event, url: string): void => {
    if (hostedUrl && isApplicationNavigation(url, hostedUrl)) return;
    event.preventDefault();
    if (isExternalLink(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (hostedUrl && isApplicationNavigation(url, hostedUrl)) void contents.loadURL(url);
    else if (isExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) showConnectionError('Check your internet connection and try again.');
  });
  contents.session.on('will-download', (_event, item) => {
    // Chromium owns the download; always ask the user to choose a destination.
    item.setSaveDialogOptions({ title: 'Save DB Chat download' });
  });
  window.on('closed', () => { window = null; });
  try { hostedUrl = configuredUrl(); void window.loadURL(hostedUrl.href).catch(() => {}); }
  catch (error) { showConnectionError((error as Error).message); }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
