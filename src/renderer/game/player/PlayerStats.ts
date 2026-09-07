import type { CharacterBaseStats, CharacterId, SkillEffectStat } from '../../../shared/types';
import { MAX_LEVEL } from '../../../shared/constants';
import { CHARACTERS, LEVEL_GAINS } from '../../data/characters/characters';
import { skillsFor } from '../../data/skills/skills';

/**
 * Derives the live stat block from the archetype, the player level and the
 * allocated skill ranks. Pure, so the UI can preview an unspent rank.
 */

export interface DerivedStats extends CharacterBaseStats {
  shieldRegenDelayMult: number;
  reloadTimeMult: number;
  cooldownMult: number;
  ammoReserveMult: number;
  damageResist: number;
}

export type EffectTotals = Record<SkillEffectStat, number>;

export function aggregateEffects(ranks: Record<string, number>, characterId: CharacterId): EffectTotals {
  const totals: EffectTotals = {
    weaponDamage: 0,
    maxShield: 0,
    maxHealth: 0,
    movementSpeed: 0,
    criticalDamage: 0,
    criticalChance: 0,
    reloadTime: 0,
    fireRate: 0,
    shieldRegenDelay: 0,
    cooldown: 0,
    ammoReserve: 0,
    damageResist: 0,
  };

  for (const skill of skillsFor(characterId)) {
    const rank = ranks[skill.id] ?? 0;
    if (rank <= 0) continue;
    totals[skill.effect.stat] += skill.effect.perRank * rank;
  }
  return totals;
}

export function deriveStats(
  characterId: CharacterId,
  level: number,
  ranks: Record<string, number>,
): DerivedStats {
  const def = CHARACTERS[characterId] ?? CHARACTERS.vanguard;
  const effects = aggregateEffects(ranks, characterId);
  const levels = Math.max(0, Math.min(MAX_LEVEL, level) - 1);

  return {
    maxHealth: Math.round(def.stats.maxHealth + levels * LEVEL_GAINS.health) * (1 + effects.maxHealth),
    maxShield: Math.round(def.stats.maxShield + levels * LEVEL_GAINS.shield) * (1 + effects.maxShield),
    movementSpeed: def.stats.movementSpeed * (1 + effects.movementSpeed),
    sprintSpeed: def.stats.sprintSpeed * (1 + effects.movementSpeed),
    criticalChance: def.stats.criticalChance + levels * LEVEL_GAINS.criticalChance + effects.criticalChance,
    criticalDamage: def.stats.criticalDamage + effects.criticalDamage,
    weaponDamageModifier:
      def.stats.weaponDamageModifier * (1 + effects.weaponDamage) * (1 + levels * LEVEL_GAINS.weaponDamage),
    skillCooldownModifier: def.stats.skillCooldownModifier * (1 + effects.cooldown),
    shieldRegenDelayMult: Math.max(0.2, 1 + effects.shieldRegenDelay),
    reloadTimeMult: Math.max(0.3, 1 + effects.reloadTime),
    cooldownMult: Math.max(0.3, def.stats.skillCooldownModifier * (1 + effects.cooldown)),
    ammoReserveMult: 1 + effects.ammoReserve,
    damageResist: Math.min(0.6, effects.damageResist),
  };
}
