import { app, BrowserWindow, Menu, shell } from 'electron';
import * as path from 'node:path';
import { registerIpcHandlers } from './ipc/handlers';

/**
 * Electron entry point.
 *
 * Dev mode  -> loads the Vite dev server (VITE_DEV_SERVER_URL or http://localhost:5173)
 * Prod mode -> loads dist-renderer/index.html built by esbuild
 */

const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: 'Dustfall Outpost',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.setMenu(null);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // External links should never open inside the game window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev) {
    void win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  }

  return win;
}

Menu.setApplicationMenu(null);

// Single-instance lock: a second launch just focuses the running game.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    registerIpcHandlers();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

export { isDev };
