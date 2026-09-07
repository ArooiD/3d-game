import type { EnemyDefinition } from '../../../shared/types';

/**
 * Enemy archetypes. Runtime HP/damage is scaled against the player level by the
 * GameDirector, so these are level-1 reference values.
 */

export const ENEMY_DEFS: Record<string, EnemyDefinition> = {
  raider: {
    id: 'raider',
    name: 'Dust Raider',
    behavior: 'raider',
    health: 62,
    shield: 0,
    damage: 8,
    moveSpeed: 4.6,
    preferredRange: 16,
    detectionRadius: 38,
    attackInterval: 1.5,
    attackRange: 26,
    xpReward: 46,
    height: 1.8,
    radius: 0.45,
    colorHex: 0xb06a3c,
    accentHex: 0xffb066,
    lootChance: 0.4,
  },
  raider_elite: {
    id: 'raider_elite',
    name: 'Raider Marauder',
    behavior: 'raider',
    health: 132,
    shield: 45,
    damage: 12,
    moveSpeed: 4.9,
    preferredRange: 14,
    detectionRadius: 42,
    attackInterval: 1.2,
    attackRange: 28,
    xpReward: 120,
    height: 2.05,
    radius: 0.55,
    colorHex: 0xd08a3a,
    accentHex: 0xffd166,
    isElite: true,
    lootChance: 0.95,
  },
  rusher: {
    id: 'rusher',
    name: 'Scrap Rusher',
    behavior: 'rusher',
    health: 46,
    shield: 0,
    damage: 16,
    moveSpeed: 7.6,
    preferredRange: 1.9,
    detectionRadius: 30,
    attackInterval: 1.15,
    attackRange: 3,
    xpReward: 52,
    height: 1.6,
    radius: 0.4,
    colorHex: 0x8f3f3f,
    accentHex: 0xff6b6b,
    lootChance: 0.36,
  },
  heavy: {
    id: 'heavy',
    name: 'Bulkhead Heavy',
    behavior: 'heavy',
    health: 240,
    shield: 120,
    damage: 21,
    moveSpeed: 2.5,
    preferredRange: 12,
    detectionRadius: 40,
    attackInterval: 2.3,
    attackRange: 22,
    xpReward: 165,
    height: 2.5,
    radius: 0.85,
    colorHex: 0x53637a,
    accentHex: 0x7fd0ff,
    lootChance: 0.8,
  },
  sniper: {
    id: 'sniper',
    name: 'Canyon Marksman',
    behavior: 'sniper',
    health: 74,
    shield: 25,
    damage: 27,
    moveSpeed: 3.6,
    preferredRange: 42,
    detectionRadius: 62,
    attackInterval: 2.9,
    attackRange: 75,
    xpReward: 92,
    height: 1.85,
    radius: 0.42,
    colorHex: 0x6c7f6a,
    accentHex: 0xa8ff9e,
    lootChance: 0.6,
  },
  scrap_titan: {
    id: 'scrap_titan',
    name: 'Scrap Titan',
    behavior: 'boss',
    health: 2600,
    shield: 1100,
    damage: 24,
    moveSpeed: 2.6,
    preferredRange: 18,
    detectionRadius: 70,
    attackInterval: 0.85,
    attackRange: 46,
    xpReward: 1200,
    height: 6.4,
    radius: 2.4,
    colorHex: 0x7a6a55,
    accentHex: 0xff8b3d,
    isElite: true,
    lootChance: 1,
  },
};

export const ENEMY_LIST = Object.values(ENEMY_DEFS);

/** Boss phase 2 summons. */
export const BOSS_SUMMONS = ['raider', 'rusher'] as const;

/** Capped so late-level scaling cannot make fights unkillable. */
export const MAX_ENEMY_LEVEL_SCALE = 2.4;

export function enemyDefinition(id: string): EnemyDefinition | null {
  return ENEMY_DEFS[id] ?? null;
}
