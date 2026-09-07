import * as THREE from 'three';
import type { Rarity, Weapon } from '../../../shared/types';
import { ELITE_DROPS, ENEMY_DROPS, DEFAULT_LOOT_CHANCE } from '../../data/loot/drops';
import { rng } from './Rng';
import { bus, GameEvents } from './EventBus';
import type { EnemyManager } from '../enemies/EnemyManager';
import type { LootSystem } from '../loot/LootSystem';
import { generateWeapon } from '../weapons/WeaponGenerator';

/**
 * Owns encounter pacing: which groups exist, when they are active, the boss
 * fight and difficulty scaling against the player level. Groups stay dormant
 * until the player is close, which keeps the frame budget flat and gives the
 * location a readable "push east" rhythm.
 */

export interface SpawnSpec {
  definitionId: string;
  /** Offset from the group anchor; converted to a world point on activation. */
  offset: { x: number; z: number };
}

export interface GroupDefinition {
  id: string;
  zone: string;
  anchor: { x: number; z: number };
  /** Group arms when the player is within this distance. */
  activationRadius: number;
  spawns: SpawnSpec[];
  /** Only spawns once the quest reaches this step id, if given. */
  requiresStep?: string;
  /** Marks the group as the mini-boss encounter. */
  boss?: boolean;
  label: string;
}

export interface DirectorContext {
  playerPosition: THREE.Vector3;
  playerLevel: number;
  /** Returns true when a quest step is done, supplied by the quest system. */
  isStepComplete: (stepId: string) => boolean;
  isCurrentStep: (stepId: string) => boolean;
}

export const GROUP_DEFS: GroupDefinition[] = [
  {
    id: 'camp_raiders',
    label: 'Scrap Camp',
    zone: 'camp',
    anchor: { x: -46, z: 52 },
    activationRadius: 42,
    spawns: [
      { definitionId: 'raider', offset: { x: -8, z: -6 } },
      { definitionId: 'raider', offset: { x: 7, z: -9 } },
      { definitionId: 'raider', offset: { x: 2, z: 9 } },
    ],
  },
  {
    id: 'canyon_ambush',
    label: 'Rust Canyon',
    zone: 'canyon',
    anchor: { x: 4, z: 6 },
    activationRadius: 44,
    spawns: [
      { definitionId: 'raider', offset: { x: -12, z: 6 } },
      { definitionId: 'raider', offset: { x: 11, z: 4 } },
      { definitionId: 'raider', offset: { x: 3, z: -13 } },
      { definitionId: 'raider', offset: { x: -5, z: 15 } },
      { definitionId: 'rusher', offset: { x: 14, z: -8 } },
      { definitionId: 'rusher', offset: { x: -16, z: -4 } },
    ],
  },
  {
    id: 'refinery_core',
    label: 'Slag Refinery',
    zone: 'refinery',
    anchor: { x: 40, z: -32 },
    activationRadius: 46,
    spawns: [
      { definitionId: 'heavy', offset: { x: 0, z: -14 } },
      { definitionId: 'sniper', offset: { x: 18, z: 8 } },
      { definitionId: 'raider_elite', offset: { x: -14, z: 5 } },
      { definitionId: 'raider', offset: { x: -6, z: 14 } },
      { definitionId: 'raider', offset: { x: 10, z: -4 } },
      { definitionId: 'rusher', offset: { x: 6, z: 18 } },
    ],
  },
  {
    id: 'titan_arena',
    label: 'Titan Arena',
    zone: 'arena',
    anchor: { x: 96, z: -96 },
    activationRadius: 40,
    boss: true,
    requiresStep: 'kill_boss',
    spawns: [{ definitionId: 'scrap_titan', offset: { x: 0, z: -18 } }],
  },
];

interface GroupRuntime {
  def: GroupDefinition;
  spawned: boolean;
  cleared: boolean;
  /** Ids spawned for this group so we can count survivors. */
  ids: string[];
}

export class GameDirector {
  private groups: GroupRuntime[] = [];
  private clearedGroups = new Set<string>();
  private bossAnnounced = false;
  /** Extra luck applied to the next generated weapon (chests, boss). */
  private pendingLuck = 0;

  constructor(
    private enemies: EnemyManager,
    private loot: LootSystem,
  ) {
    this.reset();
  }

  reset(): void {
    this.groups = GROUP_DEFS.map((def) => ({ def, spawned: false, cleared: false, ids: [] }));
    this.clearedGroups.clear();
    this.bossAnnounced = false;
  }

  /** Restores cleared state after loading a save so dead groups stay dead. */
  markCleared(ids: string[]): void {
    for (const id of ids) {
      this.clearedGroups.add(id);
      const group = this.groups.find((entry) => entry.def.id === id);
      if (group) {
        group.spawned = true;
        group.cleared = true;
      }
    }
  }

  get clearedGroupIds(): string[] {
    return [...this.clearedGroups];
  }

  /** Rolls a drop for a kill and spawns it in the world. */
  rollDrop(payload: {
    definitionId: string;
    position: THREE.Vector3;
    isBoss: boolean;
    isElite: boolean;
    lootChance: number;
    playerLevel: number;
    bossMinion?: boolean;
  }): void {
    const scatter = (offset: number): THREE.Vector3 =>
      new THREE.Vector3(
        payload.position.x + rng.float(-1.6, 1.6),
        payload.position.y,
        payload.position.z + rng.float(-1.6, 1.6) + offset,
      );

    if (payload.isBoss) {
      // Guaranteed Rare+, small chance of Legendary.
      const rarity: Rarity = rng.bool(0.12) ? 'legendary' : rng.bool(0.55) ? 'epic' : 'rare';
      const weapon = generateWeapon({ level: payload.playerLevel + 1, rarity, luck: 0.4 });
      this.loot.dropWeapon(weapon, scatter(0));
      const second = generateWeapon({ level: payload.playerLevel, rarity: rng.bool(0.4) ? 'epic' : 'rare' });
      this.loot.dropWeapon(second, scatter(1.5));
      this.loot.dropConsumable('health', scatter(-1.5), 120);
      this.loot.dropConsumable('shield', scatter(2.5), 120);
      return;
    }

    const chance = payload.isElite ? 1 : payload.lootChance || DEFAULT_LOOT_CHANCE;
    if (!rng.bool(chance)) return;

    const table = payload.isElite ? ELITE_DROPS : ENEMY_DROPS;
    const total = table.reduce((sum, entry) => sum + entry.weight, 0);
    const roll = rng.float(0, total);
    let cursor = 0;
    let picked = table[0];
    for (const entry of table) {
      cursor += entry.weight;
      if (roll <= cursor) {
        picked = entry;
        break;
      }
    }

    if (picked.kind === 'weapon') {
      const luck = payload.isElite ? 0.28 : this.pendingLuck;
      this.pendingLuck = 0;
      const weapon = generateWeapon({ level: payload.playerLevel, luck });
      this.loot.dropWeapon(weapon, scatter(0));
      return;
    }
    this.loot.dropConsumable(picked.kind, scatter(0), picked.amount ?? 25, picked.kind === 'currency' ? 'uncommon' : 'common');
  }

  /** Nudges the next weapon drop upward (used by the F6 debug chest). */
  grantLuck(amount: number): void {
    this.pendingLuck = Math.min(0.9, this.pendingLuck + amount);
  }

  update(context: DirectorContext): void {
    for (const group of this.groups) {
      if (group.spawned) {
        if (!group.cleared) this.checkCleared(group);
        continue;
      }
      if (this.clearedGroups.has(group.def.id)) continue;
      if (group.def.requiresStep && !context.isStepComplete(group.def.requiresStep) && group.def.boss) {
        // The boss only materialises when the quest asks for it.
        if (!context.isCurrentStep('kill_boss')) continue;
      }

      const distance = Math.hypot(
        group.def.anchor.x - context.playerPosition.x,
        group.def.anchor.z - context.playerPosition.z,
      );
      if (distance > group.def.activationRadius) continue;

      this.spawnGroup(group, context);
    }
  }

  private spawnGroup(group: GroupRuntime, context: DirectorContext): void {
    group.spawned = true;
    group.ids = [];

    const requests = group.def.spawns.map((spec) => ({
      definitionId: spec.definitionId,
      x: group.def.anchor.x + spec.offset.x,
      z: group.def.anchor.z + spec.offset.z,
      bossMinion: Boolean(group.def.boss),
    }));

    const spawned = this.enemies.spawnGroup(requests, context.playerLevel);
    for (const enemy of spawned) {
      group.ids.push(enemy.id);
      // Enemies start asleep so the player picks the moment to engage.
      if (!group.def.boss) enemy.state = 'patrol';
    }

    if (group.def.boss) {
      const boss = spawned[0];
      if (boss) {
        boss.forceAggro();
        if (!this.bossAnnounced) {
          this.bossAnnounced = true;
          bus.emit(GameEvents.BossSpawned, { name: boss.definition.name, id: boss.id });
        }
      }
    }

    bus.emit(GameEvents.WaveStarted, { id: group.def.id, label: group.def.label, count: spawned.length });
  }

  private checkCleared(group: GroupRuntime): void {
    for (const id of group.ids) {
      const enemy = this.enemies.findById(id);
      if (enemy && enemy.alive) return;
    }
    group.cleared = true;
    this.clearedGroups.add(group.def.id);
    bus.emit(GameEvents.ObjectiveReached, { groupId: group.def.id, label: group.def.label, cleared: true });
    bus.emit(GameEvents.Autosave, { reason: 'group_cleared' });
  }

  /** Debug/cheat support: drop a rarity-favoured chest near the player. */
  spawnChest(position: THREE.Vector3, playerLevel: number, rarity?: Rarity): Weapon {
    const weapon = generateWeapon({ level: playerLevel, rarity: rarity ?? 'rare', luck: 0.5 });
    this.loot.dropWeapon(weapon, position);
    return weapon;
  }

  /** How many enemies remain across every group, for the debug overlay. */
  get aliveEnemies(): number {
    return this.enemies.aliveCount;
  }

  get nextGroupLabel(): string {
    for (const group of this.groups) {
      if (!group.cleared && !this.clearedGroups.has(group.def.id)) return group.def.label;
    }
    return 'Clear';
  }
}
