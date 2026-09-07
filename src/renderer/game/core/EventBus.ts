/**
 * Tiny synchronous event bus. Systems communicate through named events instead
 * of holding direct references to each other.
 */

export type EventBusHandler<T = unknown> = (payload: T) => void;

interface BusRecord {
  fn: EventBusHandler<never>;
  once: boolean;
  owner?: object;
}

export class EventBus {
  private listeners = new Map<string, BusRecord[]>();

  on<T>(type: string, handler: EventBusHandler<T>, owner?: object): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn: handler as EventBusHandler<never>, once: false, owner });
    this.listeners.set(type, list);
  }

  once<T>(type: string, handler: EventBusHandler<T>, owner?: object): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn: handler as EventBusHandler<never>, once: true, owner });
    this.listeners.set(type, list);
  }

  off(type: string, handler: EventBusHandler<never>): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.findIndex((entry) => entry.fn === handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** Remove every listener registered by an owner (used on teardown). */
  offOwner(owner: object): void {
    for (const [type, list] of this.listeners) {
      const kept = list.filter((entry) => entry.owner !== owner);
      if (kept.length === 0) this.listeners.delete(type);
      else this.listeners.set(type, kept);
    }
  }

  emit<T>(type: string, payload?: T): void {
    const list = this.listeners.get(type);
    if (!list || list.length === 0) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const entry of list.slice()) {
      if (entry.once) this.off(type, entry.fn);
      try {
        entry.fn(payload as never);
      } catch (err) {
        console.error(`[eventbus] handler for "${type}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

/** Single shared bus for the running game session. */
export const bus = new EventBus();

/** Well-known event names. */
export const GameEvents = {
  EnemyKilled: 'enemy:killed',
  EnemyDamaged: 'enemy:damaged',
  EnemyPartBroken: 'enemy:part-broken',
  EnemySpawned: 'enemy:spawned',
  PlayerDamaged: 'player:damaged',
  PlayerShieldBreak: 'player:shieldbreak',
  PlayerShieldStart: 'player:shieldstart',
  PlayerDied: 'player:died',
  PlayerLevelUp: 'player:levelup',
  PlayerHealed: 'player:healed',
  LootDropped: 'loot:dropped',
  LootPicked: 'loot:picked',
  LootFocused: 'loot:focused',
  WeaponEquipped: 'weapon:equipped',
  WeaponFired: 'weapon:fired',
  WeaponReloaded: 'weapon:reloaded',
  WeaponEmpty: 'weapon:empty',
  QuestUpdated: 'quest:updated',
  QuestCompleted: 'quest:completed',
  BossSpawned: 'boss:spawned',
  BossPhase: 'boss:phase',
  BossSummon: 'boss:summon',
  BossKilled: 'boss:killed',
  SkillUnlocked: 'skill:unlocked',
  SkillPointChanged: 'skill:points',
  ActiveSkillUsed: 'skill:active',
  InventoryChanged: 'inventory:changed',
  Autosave: 'game:autosave',
  ZoneEntered: 'world:zone',
  WaveStarted: 'director:wave',
  ObjectiveReached: 'director:objective',
} as const;