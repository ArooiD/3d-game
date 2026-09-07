import { bus } from './EventBus';
import { clamp } from './Rng';

/**
 * Application state machine. Keeps exactly one active state and notifies
 * listeners on transitions, so UI panels and the simulation can react without
 * knowing about each other.
 */

export const AppState = {
  Boot: 'BOOT',
  MainMenu: 'MAIN_MENU',
  CharacterSelect: 'CHARACTER_SELECT',
  Loading: 'LOADING',
  Playing: 'PLAYING',
  Paused: 'PAUSED',
  Inventory: 'INVENTORY',
  Skills: 'SKILLS',
  Settings: 'SETTINGS',
  GameOver: 'GAME_OVER',
  Victory: 'VICTORY',
} as const;

export type AppStateName = (typeof AppState)[keyof typeof AppState];

/** States where the world simulation should not advance. */
const SIMULATION_FROZEN: AppStateName[] = [
  AppState.MainMenu,
  AppState.CharacterSelect,
  AppState.Loading,
  AppState.Paused,
  AppState.Inventory,
  AppState.Skills,
  AppState.Settings,
  AppState.GameOver,
  AppState.Victory,
];

/** States where a modal panel covers the world (pointer released). */
const MODAL_STATES: AppStateName[] = [
  AppState.MainMenu,
  AppState.CharacterSelect,
  AppState.Loading,
  AppState.Paused,
  AppState.Inventory,
  AppState.Skills,
  AppState.Settings,
  AppState.GameOver,
  AppState.Victory,
];

interface Transition {
  from: AppStateName;
  to: AppStateName;
}

class GameStateManager {
  private current: AppStateName = AppState.Boot;
  private history: AppStateName[] = [];

  get state(): AppStateName {
    return this.current;
  }

  get previous(): AppStateName | undefined {
    return this.history[this.history.length - 1];
  }

  isPlaying(): boolean {
    return this.current === AppState.Playing;
  }

  isSimulationFrozen(): boolean {
    return SIMULATION_FROZEN.includes(this.current);
  }

  isModal(): boolean {
    return MODAL_STATES.includes(this.current);
  }

  /** Returns false when the transition is illegal (defensive, keeps state clean). */
  set(next: AppStateName): boolean {
    if (next === this.current) return false;
    const transition: Transition = { from: this.current, to: next };
    this.history.push(this.current);
    if (this.history.length > 12) this.history.shift();
    this.current = next;
    bus.emit('state:changed', transition);
    return true;
  }

  /** Toggle helper for overlay panels: panel <-> Playing. */
  toggleOverlay(panel: AppStateName): AppStateName {
    if (this.current === panel) {
      const back = this.previous;
      this.set(back === AppState.Paused ? AppState.Paused : AppState.Playing);
    } else if (this.current === AppState.Playing || this.current === AppState.Paused) {
      this.set(panel);
    }
    return this.current;
  }

  reset(): void {
    this.history = [];
    this.current = AppState.MainMenu;
    bus.emit('state:changed', { from: AppState.Boot, to: AppState.MainMenu } satisfies Transition);
  }
}

export const states = new GameStateManager();

/** Small observable store so UI can subscribe to numbers without polling. */
export interface StoreValue {
  value: number;
  label?: string;
}

export class Store {
  private values = new Map<string, StoreValue>();

  set(key: string, value: number, label?: string): void {
    const prev = this.values.get(key);
    if (prev && prev.value === value && prev.label === label) return;
    this.values.set(key, { value, label });
    bus.emit(`store:${key}`, { key, value, label });
  }

  get(key: string): number {
    return this.values.get(key)?.value ?? 0;
  }

  add(key: string, delta: number): number {
    const next = clamp(this.get(key) + delta, 0, Number.MAX_SAFE_INTEGER);
    this.set(key, next);
    return next;
  }

  subscribe(key: string, handler: (value: number, label?: string) => void): void {
    bus.on(`store:${key}`, (payload: { value: number; label?: string }) =>
      handler(payload.value, payload.label),
    );
    const initial = this.values.get(key);
    if (initial) handler(initial.value, initial.label);
  }

  clear(): void {
    this.values.clear();
  }
}

export const store = new Store();
