import { app, ipcMain } from 'electron';
import { IPC_CHANNELS, type SaveGame, type SettingsState } from '../../shared/types';
import * as store from '../save/saveStore';

/** Wires renderer IPC requests to the filesystem-backed save store. */
export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.saveGame, (_event, fileName: string, data: SaveGame) =>
    store.saveGame(String(fileName), data),
  );

  ipcMain.handle(IPC_CHANNELS.loadGame, (_event, fileName: string) =>
    store.loadGame(String(fileName)),
  );

  ipcMain.handle(IPC_CHANNELS.listSaves, () => store.listSaves());

  ipcMain.handle(IPC_CHANNELS.deleteSave, (_event, fileName: string) =>
    store.deleteSave(String(fileName)),
  );

  ipcMain.handle(IPC_CHANNELS.getSettings, () => store.getSettings());

  ipcMain.handle(IPC_CHANNELS.setSettings, (_event, settings: SettingsState) =>
    store.setSettings(settings),
  );

  ipcMain.handle(IPC_CHANNELS.quitApp, () => {
    app.quit();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.isDev, () => !app.isPackaged);
}
