import type { WeaponType } from '../../../shared/types';

/**
 * Weapon name fragments. All original — assembled as Prefix + Base + Suffix so
 * every drop reads distinctively without hand-authoring hundreds of guns.
 */

export const NAME_PREFIXES = [
  'Rustfang',
  'Dustmaker',
  'Iron Viper',
  'Scrapstorm',
  'Neon Reaper',
  'Ashpit',
  'Cinder',
  'Bonepicker',
  'Static',
  'Gravewind',
  'Copperhead',
  'Hollow',
  'Sunscorched',
  'Slagborn',
  'Vulture',
  'Kiln',
  'Rattlebox',
  'Widowmaker',
  'Gritwork',
  'Saltbite',
];

export const NAME_BASES: Record<WeaponType, string[]> = {
  pistol: ['Sidearm', 'Peacemaker', 'Lockbox', 'Handcannon', 'Short Fuse', 'Backtalk'],
  assault_rifle: ['Service Rifle', 'Pattern Rifle', 'Linekeeper', 'Dragoon', 'Carbine', 'Harness'],
  shotgun: ['Breacher', 'Scattergun', 'Door Key', 'Salvage Gun', 'Closeout', 'Scrapgun'],
  sniper_rifle: ['Longshot', 'Deadeye', 'Spire Rifle', 'Lancet', 'Overwatch', 'Vantage'],
  smg: ['Buzzsaw', 'Needler', 'Rattler', 'Sprayer', 'Grinder', 'Chatterbox'],
};

/** Model-code suffixes, e.g. "AR-4". */
export const NAME_MODEL_CODES: Record<WeaponType, string> = {
  pistol: 'P',
  assault_rifle: 'AR',
  shotgun: 'SG',
  sniper_rifle: 'SR',
  smg: 'SM',
};

/** Suffix adjectives appended for higher rarities. */
export const NAME_SUFFIXES = [
  'Mk. II',
  'Mk. III',
  'Heavy',
  'Prime',
  'Verdict',
  'Reclaimer',
  'Overclocked',
  'Wasteland',
  'Longtooth',
  'Ember',
  'Zero Point',
  'Last Word',
];

/** Named legendary-style flavour prefixes used when rarity is legendary. */
export const LEGENDARY_NAMES = [
  'Widowmaker',
  'Dustmaker',
  'Neon Reaper',
  'Iron Viper',
  'Scrapstorm',
  'Grave Tide',
  'Sun Eater',
  'Rust Sermon',
];

import type { RNG } from '../../game/core/Rng';

/**
 * Assembles a weapon name as Prefix + Base + Suffix. Legendaries draw from the
 * named table so the best drops feel like unique finds.
 */
export function pickName(
  base: { type: WeaponType; label: string },
  rarity: string,
  rng: RNG,
): string {
  if (rarity === 'legendary') {
    const famous = rng.pick(LEGENDARY_NAMES);
    const code = `${NAME_MODEL_CODES[base.type]}-${rng.int(1, 99)}`;
    return `${famous} ${code}`;
  }

  const prefix = rng.pick(NAME_PREFIXES);
  const baseName = rng.pick(NAME_BASES[base.type]);
  const code = `${NAME_MODEL_CODES[base.type]}-${rng.int(1, 12)}`;

  if (rarity === 'epic') {
    return `${prefix} ${baseName} ${rng.pick(NAME_SUFFIXES)}`;
  }
  if (rarity === 'rare') {
    return rng.bool(0.5) ? `${prefix} ${baseName} ${code}` : `${prefix} ${baseName}`;
  }
  if (rarity === 'uncommon') {
    return `${prefix} ${baseName}`;
  }
  return `${baseName} ${code}`;
}
