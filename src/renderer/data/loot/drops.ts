/**
 * Loot drop tables. Weighted so a kill usually yields something, but rarely the
 * best possible roll. Everything here is data so tuning never touches code.
 */

export type PickupKind = 'weapon' | 'health' | 'shield' | 'currency';

export interface DropTableEntry {
  kind: PickupKind;
  weight: number;
  /** Amount for consumables / currency. */
  amount?: number;
}

/** What an ordinary kill throws off. */
export const ENEMY_DROPS: DropTableEntry[] = [
  { kind: 'weapon', weight: 34 },
  { kind: 'health', weight: 24, amount: 45 },
  { kind: 'shield', weight: 22, amount: 40 },
  { kind: 'currency', weight: 20, amount: 25 },
];

/** Elites are guaranteed a weapon roll with bonus luck. */
export const ELITE_DROPS: DropTableEntry[] = [
  { kind: 'weapon', weight: 70 },
  { kind: 'health', weight: 15, amount: 60 },
  { kind: 'shield', weight: 15, amount: 60 },
];

/** Mini-boss: guaranteed Rare+ weapon plus consumables. */
export const BOSS_DROPS: DropTableEntry[] = [
  { kind: 'weapon', weight: 100 },
  { kind: 'weapon', weight: 100 },
  { kind: 'health', weight: 100, amount: 120 },
  { kind: 'shield', weight: 100, amount: 120 },
];

export const PICKUP_VALUES = {
  health: 45,
  shield: 40,
};

/** Loot chance per enemy behaviour when nothing more specific applies. */
export const DEFAULT_LOOT_CHANCE = 0.34;

/** How much scatter dropped items get, in meters. */
export const DROP_SCATTER = 1.5;

/** Distance at which an item shows its interaction prompt. */
export const INTERACT_RANGE = 3.4;
