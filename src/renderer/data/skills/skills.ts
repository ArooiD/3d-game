import type { CharacterId, SkillBranch, SkillDefinition, SkillEffectStat } from '../../../shared/types';

/**
 * Skill trees: three branches per archetype, four skills per branch, 1-3 ranks.
 * Authored as compact rows and expanded below so balance edits stay a one-line
 * change per skill.
 */

type Row = [
  key: string,
  name: string,
  stat: SkillEffectStat,
  perRank: number,
  unit: 'percent' | 'flat',
  ranks: number,
  tier: number,
  requires?: string,
];

interface BranchSpec {
  branch: SkillBranch;
  rows: Row[];
}

const BRANCHES: Record<CharacterId, BranchSpec[]> = {
  vanguard: [
    {
      branch: 'offense',
      rows: [
        ['wgn', 'Breaching Power', 'weaponDamage', 0.12, 'percent', 3, 0],
        ['crd', 'Skullcracker', 'criticalDamage', 0.22, 'percent', 3, 1, 'wgn'],
        ['rof', 'Slam Fire', 'fireRate', 0.09, 'percent', 2, 1, 'wgn'],
        ['shb', 'Shield Cracker', 'weaponDamage', 0.1, 'percent', 2, 2, 'crd'],
      ],
    },
    {
      branch: 'defense',
      rows: [
        ['hlt', 'Bulwark Frame', 'maxHealth', 0.14, 'percent', 3, 0],
        ['drf', 'Impact Plating', 'damageResist', 0.08, 'percent', 3, 1, 'hlt'],
        ['shd', 'Emergency Cell', 'maxShield', 0.15, 'percent', 2, 1, 'hlt'],
        ['srg', 'Adrenal Surge', 'shieldRegenDelay', -0.3, 'percent', 2, 2, 'drf'],
      ],
    },
    {
      branch: 'utility',
      rows: [
        ['msp', 'Charging Stride', 'movementSpeed', 0.09, 'percent', 3, 0],
        ['ccd', 'Overdrive Tuning', 'cooldown', -0.14, 'percent', 3, 1, 'msp'],
        ['rlt', 'Shell Drum', 'reloadTime', -0.12, 'percent', 2, 1, 'msp'],
        ['amr', 'Bandolier', 'ammoReserve', 0.4, 'percent', 2, 2, 'ccd'],
      ],
    },
  ],
  ranger: [
    {
      branch: 'offense',
      rows: [
        ['crc', 'Steady Breath', 'criticalChance', 0.06, 'percent', 3, 0],
        ['crd', 'Glass Jaw Scope', 'criticalDamage', 0.25, 'percent', 3, 1, 'crc'],
        ['wgn', 'Match Grade', 'weaponDamage', 0.09, 'percent', 3, 1, 'crc'],
        ['rof', 'Follow Through', 'fireRate', 0.08, 'percent', 2, 2, 'crd'],
      ],
    },
    {
      branch: 'defense',
      rows: [
        ['shd', 'Recon Screen', 'maxShield', 0.16, 'percent', 3, 0],
        ['hlt', 'Field Medicine', 'maxHealth', 0.1, 'percent', 2, 1, 'shd'],
        ['srg', 'Quick Patch', 'shieldRegenDelay', -0.3, 'percent', 3, 1, 'shd'],
        ['drf', 'Defilade', 'damageResist', 0.06, 'percent', 2, 2, 'srg'],
      ],
    },
    {
      branch: 'utility',
      rows: [
        ['msp', 'Scout Pace', 'movementSpeed', 0.1, 'percent', 3, 0],
        ['rlt', 'Bolt Cycle', 'reloadTime', -0.16, 'percent', 3, 1, 'msp'],
        ['ccd', 'Focus Cooling', 'cooldown', -0.14, 'percent', 2, 2, 'rlt'],
        ['amr', 'Spotter Feed', 'ammoReserve', 0.35, 'percent', 2, 1, 'msp'],
      ],
    },
  ],
  engineer: [
    {
      branch: 'offense',
      rows: [
        ['rof', 'Cycle Boost', 'fireRate', 0.1, 'percent', 3, 0],
        ['wgn', 'Printed Ammo', 'weaponDamage', 0.1, 'percent', 3, 1, 'rof'],
        ['crd', 'Vital Scanner', 'criticalDamage', 0.18, 'percent', 2, 1, 'rof'],
        ['shb', 'Arc Piercer', 'weaponDamage', 0.12, 'percent', 2, 2, 'wgn'],
      ],
    },
    {
      branch: 'defense',
      rows: [
        ['shd', 'Capacitor Bank', 'maxShield', 0.22, 'percent', 3, 0],
        ['srg', 'Rapid Recapture', 'shieldRegenDelay', -0.32, 'percent', 3, 1, 'shd'],
        ['hlt', 'Chassis Patch', 'maxHealth', 0.1, 'percent', 2, 1, 'shd'],
        ['drf', 'Faraday Skin', 'damageResist', 0.07, 'percent', 2, 2, 'srg'],
      ],
    },
    {
      branch: 'utility',
      rows: [
        ['ccd', 'Servo Cooling', 'cooldown', -0.15, 'percent', 3, 0],
        ['amr', 'Drone Feed', 'ammoReserve', 0.45, 'percent', 3, 1, 'ccd'],
        ['rlt', 'Mag Ejector', 'reloadTime', -0.15, 'percent', 2, 1, 'ccd'],
        ['msp', 'Servo Legs', 'movementSpeed', 0.07, 'percent', 2, 2, 'amr'],
      ],
    },
  ],
};

const BRANCH_BLURB: Record<SkillBranch, string> = {
  offense: 'Damage, crits and rate of fire',
  defense: 'Health, shields and mitigation',
  utility: 'Speed, reload and cooldowns',
};

export const BRANCH_LABELS = BRANCH_BLURB;

function expand(characterId: CharacterId): SkillDefinition[] {
  const out: SkillDefinition[] = [];
  for (const spec of BRANCHES[characterId]) {
    for (const [key, name, stat, perRank, unit, ranks, tier, requires] of spec.rows) {
      out.push({
        id: `${characterId}_${spec.branch}_${key}`,
        characterId,
        branch: spec.branch,
        name,
        description: describe(stat, perRank, unit),
        maxRanks: ranks,
        effect: { stat, perRank, unit },
        requires: requires ? `${characterId}_${spec.branch}_${requires}` : undefined,
        tier,
      });
    }
  }
  return out;
}

function describe(stat: SkillEffectStat, perRank: number, unit: 'percent' | 'flat'): string {
  const amount = unit === 'percent' ? `${Math.abs(Math.round(perRank * 100))}%` : `${perRank}`;
  const dir = perRank < 0 ? 'reduces' : 'increases';
  const names: Record<SkillEffectStat, string> = {
    weaponDamage: 'weapon damage',
    maxShield: 'maximum shield',
    maxHealth: 'maximum health',
    movementSpeed: 'movement speed',
    criticalDamage: 'critical damage',
    criticalChance: 'critical chance',
    reloadTime: 'reload time',
    fireRate: 'fire rate',
    shieldRegenDelay: 'shield regen delay',
    cooldown: 'ability cooldown',
    ammoReserve: 'reserve ammo',
    damageResist: 'damage resistance',
  };
  return `${dir.startsWith('r') ? dir : dir} ${names[stat]} by ${amount} per rank.`;
}

export const SKILLS: SkillDefinition[] = (Object.keys(BRANCHES) as CharacterId[]).flatMap(expand);

export function skillsFor(characterId: CharacterId): SkillDefinition[] {
  return SKILLS.filter((skill) => skill.characterId === characterId);
}

export function skillById(id: string): SkillDefinition | undefined {
  return SKILLS.find((skill) => skill.id === id);
}

export const BRANCH_ORDER: SkillBranch[] = ['offense', 'defense', 'utility'];
