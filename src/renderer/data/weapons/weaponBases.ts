import type { WeaponType } from '../../../shared/types';

/**
 * Weapon archetype templates. The procedural generator composes these with a
 * level, a rarity tier and random modifiers to produce final weapons, so no
 * individual gun is hand-authored.
 */

export interface WeaponBase {
  type: WeaponType;
  label: string;
  shortLabel: string;
  /** Base per-shot damage at level 1. */
  damage: number;
  /** Rounds per second. */
  fireRate: number;
  magazineSize: number;
  reloadTime: number;
  /** 0..1 — higher is tighter. Drives spread. */
  accuracy: number;
  /** Recoil kick in radians per shot. */
  recoil: number;
  criticalMultiplier: number;
  pellets: number;
  /** Base spread in radians while hip firing. */
  spread: number;
  range: number;
  /** 0 = hitscan, > 0 = travelling projectile at this speed (m/s). */
  projectileSpeed: number;
  shieldDamageBonus: number;
  /** Screen shake impulse on fire. */
  shake: number;
  /** Damage falloff past 60% of range (0..1 fraction removed). */
  falloff: number;
  modelColor: number;
  modelScale: [number, number, number];
}

export const WEAPON_BASES: Record<WeaponType, WeaponBase> = {
  pistol: {
    type: 'pistol',
    label: 'Pistol',
    shortLabel: 'PS',
    damage: 24,
    fireRate: 4.4,
    magazineSize: 14,
    reloadTime: 1.35,
    accuracy: 0.82,
    recoil: 0.016,
    criticalMultiplier: 2,
    pellets: 1,
    spread: 0.014,
    range: 90,
    projectileSpeed: 0,
    shieldDamageBonus: 0,
    shake: 0.22,
    falloff: 0.3,
    modelColor: 0x9aa6b8,
    modelScale: [0.1, 0.16, 0.42],
  },
  assault_rifle: {
    type: 'assault_rifle',
    label: 'Assault Rifle',
    shortLabel: 'AR',
    damage: 19,
    fireRate: 7.2,
    magazineSize: 30,
    reloadTime: 2.2,
    accuracy: 0.78,
    recoil: 0.013,
    criticalMultiplier: 1.9,
    pellets: 1,
    spread: 0.021,
    range: 140,
    projectileSpeed: 0,
    shieldDamageBonus: 0,
    shake: 0.24,
    falloff: 0.28,
    modelColor: 0x7f8b9e,
    modelScale: [0.11, 0.17, 0.78],
  },
  shotgun: {
    type: 'shotgun',
    label: 'Shotgun',
    shortLabel: 'SG',
    damage: 12,
    fireRate: 1.25,
    magazineSize: 6,
    reloadTime: 2.9,
    accuracy: 0.4,
    recoil: 0.075,
    criticalMultiplier: 1.6,
    pellets: 8,
    spread: 0.085,
    range: 34,
    projectileSpeed: 0,
    shieldDamageBonus: 0,
    shake: 0.85,
    falloff: 0.62,
    modelColor: 0x8c6f4f,
    modelScale: [0.14, 0.19, 0.92],
  },
  sniper_rifle: {
    type: 'sniper_rifle',
    label: 'Sniper Rifle',
    shortLabel: 'SR',
    damage: 118,
    fireRate: 0.85,
    magazineSize: 5,
    reloadTime: 3.1,
    accuracy: 0.98,
    recoil: 0.11,
    criticalMultiplier: 3.2,
    pellets: 1,
    spread: 0.002,
    range: 320,
    projectileSpeed: 0,
    shieldDamageBonus: 0.15,
    shake: 1.1,
    falloff: 0,
    modelColor: 0x5d6f86,
    modelScale: [0.1, 0.15, 1.22],
  },
  smg: {
    type: 'smg',
    label: 'SMG',
    shortLabel: 'SMG',
    damage: 12.5,
    fireRate: 12.5,
    magazineSize: 38,
    reloadTime: 1.9,
    accuracy: 0.6,
    recoil: 0.01,
    criticalMultiplier: 1.7,
    pellets: 1,
    spread: 0.036,
    range: 72,
    projectileSpeed: 0,
    shieldDamageBonus: 0,
    shake: 0.16,
    falloff: 0.42,
    modelColor: 0x6f7d8c,
    modelScale: [0.1, 0.15, 0.55],
  },
};

export const WEAPON_TYPE_LIST = Object.keys(WEAPON_BASES) as WeaponType[];

/** Per-level growth applied to damage so loot stays relevant as you rank up. */
export const WEAPON_LEVEL_DAMAGE_GROWTH = 0.16;
export const WEAPON_LEVEL_MAG_GROWTH = 0.05;
