import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SaveGame, SaveSummary, SettingsState } from '../../shared/types';
import { SAVE_VERSION } from '../../shared/constants';

/**
 * JSON / local-filesystem save storage.
 *
 * Layout inside userData:
 *   saves/slot-1.json      (and slot-2.json, ...)
 *   settings.json
 */

const SAVE_FILE = /^slot-\d+\.json$/;

function savesDir(): string {
  const dir = path.join(app.getPath('userData'), 'saves');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readJsonSafe<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    console.error('[save] failed to read', file, err);
    return null;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function saveGame(fileName: string, data: SaveGame): { ok: boolean; error?: string } {
  try {
    if (!SAVE_FILE.test(fileName)) {
      return { ok: false, error: `Invalid save file name "${fileName}"` };
    }
    writeJsonAtomic(path.join(savesDir(), fileName), data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function loadGame(fileName: string): SaveGame | null {
  if (!SAVE_FILE.test(fileName)) return null;
  const data = readJsonSafe<SaveGame>(path.join(savesDir(), fileName));
  if (!data) return null;
  if (data.version !== SAVE_VERSION) {
    // Single-version MVP: refuse incompatible saves instead of half-migrating.
    console.warn(`[save] ${fileName} has version ${data.version}, expected ${SAVE_VERSION}`);
  }
  return data;
}

function summarize(fileName: string, data: SaveGame): SaveSummary {
  const quest = Object.values(data.quests ?? {})[0];
  const step = quest?.steps?.[Math.min(quest.currentStep ?? 0, (quest.steps?.length ?? 1) - 1)];
  return {
    fileName,
    version: data.version ?? SAVE_VERSION,
    characterId: data.character?.characterId ?? 'vanguard',
    characterName: data.character?.name ?? 'Unknown',
    level: data.character?.level ?? 1,
    playtimeSeconds: data.playtimeSeconds ?? 0,
    updatedAt: data.updatedAt ?? 0,
    questText: step?.text ?? '',
  };
}

export function listSaves(): SaveSummary[] {
  const dir = savesDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => SAVE_FILE.test(f));
  } catch {
    return [];
  }
  const summaries: SaveSummary[] = [];
  for (const fileName of entries) {
    const data = readJsonSafe<SaveGame>(path.join(dir, fileName));
    if (data) summaries.push(summarize(fileName, data));
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function hasAnySave(): boolean {
  return listSaves().length > 0;
}

export function deleteSave(fileName: string): { ok: boolean } {
  try {
    if (SAVE_FILE.test(fileName)) {
      const file = path.join(savesDir(), fileName);
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    return { ok: true };
  } catch (err) {
    console.error('[save] delete failed', err);
    return { ok: false };
  }
}

export function getSettings(): SettingsState | null {
  return readJsonSafe<SettingsState>(settingsPath());
}

export function setSettings(settings: SettingsState): { ok: boolean } {
  try {
    writeJsonAtomic(settingsPath(), settings);
    return { ok: true };
  } catch (err) {
    console.error('[settings] write failed', err);
    return { ok: false };
  }
}
