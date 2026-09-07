import type { CharacterDefinition } from '../../../shared/types';

/**
 * Playable archetypes. They share one procedural player rig; what differs is the
 * stat block and the active ability. Baseline is HP 100 / Shield 50 / Move 7 /
 * Sprint 11, with each archetype leaning into a fantasy.
 */

export const CHARACTERS: Record<string, CharacterDefinition> = {
  vanguard: {
    id: 'vanguard',
    name: 'Vanguard',
    tagline: 'front-line breaker',
    description:
      'Heavy plating and a short fuse. Vanguard soaks punishment that would drop anyone else and closes the distance to make it hurt.',
    specialties: ['High health', 'Shotguns', 'Close range'],
    preferredWeapons: ['shotgun', 'pistol'],
    startingWeapon: 'shotgun',
    activeSkillId: 'overdrive',
    colorHex: 0xc9622f,
    stats: {
      maxHealth: 140,
      maxShield: 40,
      movementSpeed: 6.8,
      sprintSpeed: 10.6,
      criticalChance: 0.05,
      criticalDamage: 1.9,
      weaponDamageModifier: 1.1,
      skillCooldownModifier: 1,
    },
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    tagline: 'long-shot specialist',
    description:
      'Patient and precise. Ranger reads a battlefield from the ridgeline and ends fights before they get close enough to matter.',
    specialties: ['Critical damage', 'Rifles', 'Long range'],
    preferredWeapons: ['sniper_rifle', 'assault_rifle'],
    startingWeapon: 'assault_rifle',
    activeSkillId: 'focus',
    colorHex: 0x3f8f5f,
    stats: {
      maxHealth: 100,
      maxShield: 45,
      movementSpeed: 7.2,
      sprintSpeed: 11.6,
      criticalChance: 0.14,
      criticalDamage: 2.5,
      weaponDamageModifier: 1,
      skillCooldownModifier: 1,
    },
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    tagline: 'field fabricator',
    description:
      'Lets the machines do the counting. Engineer runs an oversized shield cell and a combat drone that never needs to reload.',
    specialties: ['Large shields', 'Automatic weapons', 'Deployables'],
    preferredWeapons: ['smg', 'pistol'],
    startingWeapon: 'smg',
    activeSkillId: 'combat_drone',
    colorHex: 0x2f7fc9,
    stats: {
      maxHealth: 90,
      maxShield: 85,
      movementSpeed: 7,
      sprintSpeed: 11,
      criticalChance: 0.07,
      criticalDamage: 2,
      weaponDamageModifier: 1,
      skillCooldownModifier: 0.85,
    },
  },
};

export const CHARACTER_LIST = Object.values(CHARACTERS);

/** Per-level gains applied on top of the archetype base. */
export const LEVEL_GAINS = {
  health: 12,
  shield: 6,
  skillPoints: 1,
  /** Fractional bonus so a level 10 character is meaningfully stronger. */
  weaponDamage: 0.03,
  criticalChance: 0.004,
};

/** Active ability definitions, keyed by activeSkillId. */
export interface ActiveSkillDef {
  id: string;
  name: string;
  hotkey: 'F' | 'Q';
  duration: number;
  cooldown: number;
  description: string;
}

export const ACTIVE_SKILLS: Record<string, ActiveSkillDef> = {
  overdrive: {
    id: 'overdrive',
    name: 'Overdrive',
    hotkey: 'F',
    duration: 8,
    cooldown: 26,
    description: '+35% move speed, +40% fire rate and +30% damage for 8 seconds.',
  },
  focus: {
    id: 'focus',
    name: 'Focus',
    hotkey: 'F',
    duration: 9,
    cooldown: 24,
    description: '+30% critical chance, +60% critical damage and near-zero spread for 9 seconds.',
  },
  combat_drone: {
    id: 'combat_drone',
    name: 'Combat Drone',
    hotkey: 'F',
    duration: 14,
    cooldown: 28,
    description: 'Deploy a drone that hunts nearby hostiles for 14 seconds.',
  },
  /** Shared second ability so both ability slots are always live. */
  frag_burst: {
    id: 'frag_burst',
    name: 'Frag Burst',
    hotkey: 'Q',
    duration: 0,
    cooldown: 16,
    description: 'Throw a fragment charge that detonates for area damage.',
  },
};

/** Frag burst tuning (shared Q ability). */
export const FRAG = {
  damage: 130,
  radius: 7.5,
  shieldBonus: 0.35,
  projectileSpeed: 22,
  fuse: 1.15,
};
