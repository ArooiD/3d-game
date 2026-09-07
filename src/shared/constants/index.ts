/** Global tuning constants. Game balance values live in src/renderer/data. */

export const SAVE_VERSION = 1;
export const MAX_LEVEL = 10;

/** World is a square, WORLD_SIZE meters per side, centred on the origin. */
export const WORLD_SIZE = 300;
export const WORLD_HALF = WORLD_SIZE / 2;

export const GRAVITY = 26;
export const JUMP_VELOCITY = 9.4;

export const PLAYER_EYE_HEIGHT = 1.7;
export const PLAYER_RADIUS = 0.42;
export const PLAYER_HEIGHT = 1.85;

/** Seconds without damage before shields start regenerating. */
export const SHIELD_REGEN_DELAY = 4;
export const SHIELD_REGEN_RATE = 15;

export const EQUIP_SLOTS = 3;
export const INVENTORY_SLOTS = 20;

export const XP_LEVEL_BASE = 100;
export const XP_LEVEL_EXPONENT = 1.5;

export const STARTING_RESERVE_MULTIPLIER = 5;

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;

export const RARITY_COLORS: Record<string, string> = {
  common: '#b9c2cc',
  uncommon: '#4ade80',
  rare: '#3b9dff',
  epic: '#b06bff',
  legendary: '#ffb020',
};

export const RARITY_HEX: Record<string, number> = {
  common: 0xb9c2cc,
  uncommon: 0x4ade80,
  rare: 0x3b9dff,
  epic: 0xb06bff,
  legendary: 0xffb020,
};

export const RARITY_LABELS: Record<string, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
};

export const RARITY_MULTIPLIER: Record<string, number> = {
  common: 1,
  uncommon: 1.13,
  rare: 1.28,
  epic: 1.48,
  legendary: 1.75,
};

export const RARITY_MODIFIER_COUNT: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

export const RARITY_DROP_WEIGHT: Record<string, number> = {
  common: 55,
  uncommon: 25,
  rare: 12,
  epic: 6,
  legendary: 2,
};

export const WEAPON_TYPE_LABELS: Record<string, string> = {
  pistol: 'Pistol',
  assault_rifle: 'Assault Rifle',
  shotgun: 'Shotgun',
  sniper_rifle: 'Sniper Rifle',
  smg: 'SMG',
};

/** Enemy HP/damage scaling relative to the player level. */
export function enemyLevelScale(level: number): number {
  return 1 + Math.max(0, level - 1) * 0.15;
}

/** Cap so a level 10 character still has a fair fight. */
export const MAX_ENEMY_LEVEL_SCALE = 2.4;

export function xpRequiredForLevel(level: number): number {
  return Math.round(XP_LEVEL_BASE * Math.pow(level, XP_LEVEL_EXPONENT));
}
