import type { Rarity, Weapon, WeaponModifier, WeaponType } from '../../../shared/types';
import { RARITY_MODIFIER_COUNT, RARITY_ORDER, STARTING_RESERVE_MULTIPLIER } from '../../../shared/constants';
import { rng } from '../core/Rng';
import { baseFor, type WeaponBase } from '../../data/weapons/weaponBases';
import { pickName } from '../../data/weapons/weaponNames';
import { MODIFIER_TEMPLATES, buildModifier, type ModifierTemplate } from '../../data/weapons/modifiers';

/**
 * Procedural weapon generation:
 *   weapon base + level + rarity + random modifiers = final weapon
 * Nothing here is authored per-gun; balance lives in data/weapons.
 */

export interface GenerateOptions {
  type?: WeaponType;
  level?: number;
  rarity?: Rarity;
  /** 0..1 bonus luck applied by chests and the mini-boss. */
  luck?: number;
}

const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 55,
  uncommon: 25,
  rare: 12,
  epic: 6,
  legendary: 2,
};

/** Weighted rarity roll, biased upward by `luck` (0..1). */
export function rollRarity(luck = 0): Rarity {
  const weights: number[] = [];
  let total = 0;
  for (const rarity of RARITY_ORDER) {
    const base = RARITY_WEIGHTS[rarity];
    const index = RARITY_ORDER.indexOf(rarity);
    const boosted = index === 0 ? base * (1 - luck * 0.85) : base * (1 + luck * index * 0.9);
    weights.push(boosted);
    total += boosted;
  }
  let roll = rng.float(0, total);
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    roll -= weights[i] as number;
    if (roll <= 0) return RARITY_ORDER[i] as Rarity;
  }
  return 'common';
}

function rollModifiers(base: WeaponBase, rarity: Rarity, level: number): WeaponModifier[] {
  const count = RARITY_MODIFIER_COUNT[rarity];
  if (count === 0) return [];
  const eligible = MODIFIER_TEMPLATES.filter(
    (template) => !template.types || template.types.includes(base.type),
  );
  const chosen: ModifierTemplate[] = [];
  const pool = [...eligible];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((sum, template) => sum + template.weight, 0);
    let roll = rng.float(0, total);
    let index = 0;
    for (let j = 0; j < pool.length; j++) {
      roll -= (pool[j] as ModifierTemplate).weight;
      if (roll <= 0) {
        index = j;
        break;
      }
    }
    const template = pool[index] as ModifierTemplate;
    chosen.push(template);
    pool.splice(index, 1);
  }
  const levelBonus = 1 + Math.max(0, level - 1) * 0.01;
  return chosen.map((template) => {
    const raw = rng.float(template.min, template.max);
    const value = template.flat ? Math.round(raw) : raw * levelBonus;
    return buildModifier(template.stat, template.label, value, Boolean(template.flat));
  });
}

/** Damage grows with item level so drops stay relevant as enemies scale. */
function levelDamageScale(level: number): number {
  return 1 + Math.max(0, level - 1) * 0.16;
}

let serial = 0;

export function generateWeapon(options: GenerateOptions = {}): Weapon {
  const base = options.type ? (baseFor(options.type) as WeaponBase) : rng.pick(Object.values(WEAPON_BASE_LIST));
  const level = Math.max(1, Math.round(options.level ?? 1));
  const rarity = options.rarity ?? rollRarity(options.luck ?? 0);
  const modifiers = rollModifiers(base, rarity, level);

  const weapon: Weapon = {
    uid: `w${Date.now().toString(36)}-${(serial++).toString(36)}-${rng.int(1000, 9999)}`,
    id: base.type,
    name: pickName(base, rarity, rng),
    weaponType: base.type,
    rarity,
    level,
    damage: round(base.damage * levelDamageScale(level), 1),
    fireRate: base.fireRate,
    magazineSize: Math.max(1, Math.round(base.magazineSize)),
    reloadTime: base.reloadTime,
    accuracy: base.accuracy,
    recoil: base.recoil,
    spread: base.spread,
    pellets: base.pellets,
    projectileSpeed: base.projectileSpeed,
    criticalMultiplier: base.criticalMultiplier,
    range: base.range,
    shieldDamageBonus: base.shieldDamageBonus,
    auto: base.fireRate >= 4,
    shake: base.shake,
    falloff: base.falloff,
    adsZoom: base.adsZoom,
    modelColor: base.modelColor,
    modelScale: base.modelScale,
    modifiers,
    ammo: base.magazineSize,
    reserveAmmo: Math.round(base.magazineSize * STARTING_RESERVE_MULTIPLIER),
  };

  applyModifiers(weapon, modifiers);
  return weapon;
}

/** Mutates `weapon` in place so UI previews can apply mods to a base preview. */
export function applyModifiers(weapon: Weapon, modifiers: WeaponModifier[]): Weapon {
  for (const modifier of modifiers) {
    const v = modifier.value;
    switch (modifier.stat) {
      case 'damage':
        weapon.damage = round(weapon.damage * (1 + v), 1);
        break;
      case 'fireRate':
        weapon.fireRate = round(weapon.fireRate * (1 + v), 2);
        break;
      case 'magazineSize': {
        const previous = weapon.magazineSize;
        weapon.magazineSize = Math.max(1, Math.round(weapon.magazineSize * (1 + v)));
        weapon.reserveAmmo += Math.max(0, weapon.magazineSize - previous);
        break;
      }
      case 'reloadTime':
        weapon.reloadTime = round(Math.max(0.3, weapon.reloadTime * (1 + v)), 2);
        break;
      case 'accuracy':
        weapon.accuracy = clamp01(weapon.accuracy * (1 + v));
        weapon.spread = Math.max(0.002, (weapon.spread ?? 0.03) * (1 - v * 0.8));
        break;
      case 'recoil':
        weapon.recoil = Math.max(0, weapon.recoil * (1 + v));
        break;
      case 'criticalMultiplier':
        weapon.criticalMultiplier = round(weapon.criticalMultiplier * (1 + v), 2);
        break;
      case 'projectiles':
        weapon.pellets = Math.max(1, (weapon.pellets ?? 1) + Math.round(v));
        break;
      case 'range':
        weapon.range = round((weapon.range ?? 80) * (1 + v), 1);
        break;
      case 'shieldDamage':
        break;
    }
  }
  return weapon;
}

export const WEAPON_BASE_LIST = {
  pistol: baseFor('pistol'),
  assault_rifle: baseFor('assault_rifle'),
  shotgun: baseFor('shotgun'),
  sniper_rifle: baseFor('sniper_rifle'),
  smg: baseFor('smg'),
} as Record<WeaponType, WeaponBase>;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Human-readable DPS estimate used by the inventory comparison view. */
export function estimatedDps(weapon: Weapon): number {
  return round(weapon.damage * (weapon.pellets ?? 1) * weapon.fireRate, 1);
}
