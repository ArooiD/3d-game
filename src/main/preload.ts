import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type GameBridge, type SaveGame, type SettingsState } from '../shared/types';

/** Minimal, explicitly typed bridge. No Node APIs reach the renderer. */
const bridge: GameBridge = {
  isDev: !!process.env.VITE_DEV_SERVER_URL,
  saveGame: (fileName: string, data: SaveGame) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveGame, fileName, data),
  loadGame: (fileName: string) => ipcRenderer.invoke(IPC_CHANNELS.loadGame, fileName),
  listSaves: () => ipcRenderer.invoke(IPC_CHANNELS.listSaves),
  deleteSave: (fileName: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteSave, fileName),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  setSettings: (settings: SettingsState) => ipcRenderer.invoke(IPC_CHANNELS.setSettings, settings),
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quitApp),
};

contextBridge.exposeInMainWorld('gameApi', bridge);
