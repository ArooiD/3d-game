import type { SaveGame, SaveSummary, SettingsState } from '../../../shared/types';
import { SAVE_VERSION } from '../../../shared/constants';
import type { CharacterId, Weapon } from '../../../shared/types';
import type { QuestState } from '../../../shared/types';
import { bus, GameEvents } from '../../game/core/EventBus';

/**
 * Client side of the save system. Persistence itself lives in the main process
 * (src/main/save) behind the preload bridge; when running in a plain browser the
 * bridge is absent and we fall back to localStorage so `vite` dev still works.
 */

const BROWSER_KEY = 'dustfall.save';
const BROWSER_SETTINGS_KEY = 'dustfall.settings';

export const DEFAULT_SETTINGS: SettingsState = {
  sensitivity: 0.0022,
  invertY: false,
  fov: 78,
  masterVolume: 0.7,
  showDamageNumbers: true,
  screenShake: 1,
  quality: 'high',
};

export interface SavePayload {
  fileName: string;
  character: {
    characterId: CharacterId;
    name: string;
    level: number;
    xp: number;
    health: number;
    shield: number;
    skillPoints: number;
  };
  progression: { skills: Record<string, number> };
  inventory: Weapon[];
  equipped: (Weapon | null)[];
  quests: Record<string, QuestState>;
  stats: SaveGame['stats'];
  settings: SettingsState;
  playerPosition: { x: number; y: number; z: number };
  playerYaw: number;
  clearedGroups: string[];
  playtimeSeconds: number;
  questText: string;
}

interface Bridge {
  isDev: boolean;
  saveGame(fileName: string, data: SaveGame): Promise<{ ok: boolean; error?: string }>;
  loadGame(fileName: string): Promise<SaveGame | null>;
  listSaves(): Promise<SaveSummary[]>;
  deleteSave(fileName: string): Promise<{ ok: boolean }>;
  getSettings(): Promise<Partial<SettingsState> | null>;
  setSettings(settings: SettingsState): Promise<{ ok: boolean }>;
  quit(): Promise<void>;
}

declare global {
  interface Window {
    gameApi?: Bridge;
  }
}

export function bridge(): Bridge | null {
  return typeof window !== 'undefined' && window.gameApi ? window.gameApi : null;
}

export function isDevelopment(): boolean {
  const declared = typeof __APP_DEV__ !== 'undefined' ? __APP_DEV__ : true;
  if (!declared) return false;
  // Bridge present means Electron; keep cheats on for both dev and preview.
  return true;
}

declare const __APP_DEV__: boolean | undefined;

export class SaveManager {
  private lastSaveAt = 0;
  private queued: SavePayload | null = null;
  private flushing = false;
  saves: SaveSummary[] = [];

  constructor(
    private fileName = 'save_slot_1.json',
    private autosaveEnabled = true,
  ) {}

  async refreshList(): Promise<SaveSummary[]> {
    const api = bridge();
    if (api) {
      this.saves = await api.listSaves();
      return this.saves;
    }
    const raw = localStorage.getItem(BROWSER_KEY);
    if (!raw) {
      this.saves = [];
      return this.saves;
    }
    try {
      const parsed = JSON.parse(raw) as SaveGame;
      this.saves = [summarize(parsed)];
    } catch {
      this.saves = [];
    }
    return this.saves;
  }

  get hasSave(): boolean {
    return this.saves.length > 0;
  }

  get latest(): SaveSummary | null {
    return this.saves[0] ?? null;
  }

  /** Writes immediately. */
  async save(payload: SavePayload): Promise<boolean> {
    const now = Date.now();
    const data: SaveGame = {
      version: SAVE_VERSION,
      createdAt: this.lastSaveAt || now,
      updatedAt: now,
      playtimeSeconds: Math.round(payload.playtimeSeconds),
      character: payload.character,
      progression: payload.progression,
      inventory: payload.inventory,
      equipped: payload.equipped,
      quests: payload.quests,
      stats: payload.stats,
      settings: payload.settings,
      playerPosition: payload.playerPosition,
      playerYaw: payload.playerYaw,
      clearedGroups: payload.clearedGroups,
    };
    this.lastSaveAt = now;

    const api = bridge();
    try {
      if (api) {
        const result = await api.saveGame(this.fileName, data);
        if (!result.ok) {
          console.error('[save] failed', result.error);
          return false;
        }
      } else {
        localStorage.setItem(BROWSER_KEY, JSON.stringify(data));
      }
      await this.refreshList();
      return true;
    } catch (error) {
      console.error('[save] threw', error);
      return false;
    }
  }

  /** Autosave entry point; throttled and coalesced so spam is cheap. */
  async autosave(payload: SavePayload, reason: string): Promise<void> {
    if (!this.autosaveEnabled) return;
    const now = performance.now();
    if (now - this.lastSaveAt < 1000) {
      this.queued = payload;
      return;
    }
    await this.save(payload);
    if (this.queued) {
      const next = this.queued;
      this.queued = null;
      await this.save(next);
    }
    void reason;
    if (this.flushing) return;
  }

  async load(): Promise<SaveGame | null> {
    const api = bridge();
    try {
      if (api) {
        const data = await api.loadGame(this.fileName);
        if (data) return normalize(data);
        return null;
      }
      const raw = localStorage.getItem(BROWSER_KEY);
      return raw ? normalize(JSON.parse(raw) as SaveGame) : null;
    } catch (error) {
      console.error('[save] load failed', error);
      return null;
    }
  }

  async deleteAll(): Promise<void> {
    const api = bridge();
    if (api) {
      for (const save of this.saves) await api.deleteSave(save.fileName);
    } else {
      localStorage.removeItem(BROWSER_KEY);
    }
    this.saves = [];
  }

  async loadSettings(): Promise<SettingsState> {
    const api = bridge();
    try {
      if (api) {
        const stored = await api.getSettings();
        return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
      }
      const raw = localStorage.getItem(BROWSER_SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as SettingsState) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async storeSettings(settings: SettingsState): Promise<void> {
    const api = bridge();
    try {
      if (api) await api.setSettings(settings);
      else localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error('[settings] save failed', error);
    }
  }

  async quit(): Promise<void> {
    const api = bridge();
    if (api) {
      await api.quit();
      return;
    }
    window.close();
  }

  /** Emits the autosave event other systems listen for. */
  static requestAutosave(reason: string): void {
    bus.emit(GameEvents.Autosave, { reason });
  }
}

function normalize(data: SaveGame): SaveGame {
  // Defensive fill so an older or hand-edited file never crashes a load.
  const equipped = Array.isArray(data.equipped) ? data.equipped : [];
  return {
    ...data,
    version: SAVE_VERSION,
    equipped: [equipped[0] ?? null, equipped[1] ?? null, equipped[2] ?? null],
    inventory: Array.isArray(data.inventory) ? data.inventory : [],
    quests: data.quests ?? {},
    progression: data.progression ?? { skills: {} },
    stats:
      data.stats ??
      { enemiesKilled: 0, bossesKilled: 0, weaponsFound: 0, shotsFired: 0, shotsHit: 0 },
    settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
    clearedGroups: Array.isArray(data.clearedGroups) ? data.clearedGroups : [],
    playtimeSeconds: data.playtimeSeconds ?? 0,
  };
}

function summarize(data: SaveGame): SaveSummary {
  const quest = Object.values(data.quests ?? {})[0];
  const step = quest?.steps?.[quest.currentStep ?? 0];
  return {
    fileName: 'save_slot_1.json',
    version: data.version ?? SAVE_VERSION,
    characterId: data.character.characterId,
    characterName: data.character.name,
    level: data.character.level,
    playtimeSeconds: data.playtimeSeconds ?? 0,
    updatedAt: data.updatedAt ?? Date.now(),
    questText: step ? step.text : 'Complete',
  };
}
