import type { CharacterId } from '../../../shared/types';
import {
  MAX_LEVEL,
  SHIELD_REGEN_DELAY,
  SHIELD_REGEN_RATE,
  XP_LEVEL_BASE,
  XP_LEVEL_EXPONENT,
} from '../../../shared/constants';
import { bus, GameEvents } from '../core/EventBus';
import { clamp } from '../core/Rng';
import { deriveStats, type DerivedStats } from './PlayerStats';

/**
 * Everything about the player that is not movement: vitals, shields, XP, levels
 * and skill allocation. Movement lives in PlayerController.
 */

export function xpRequiredForLevel(level: number): number {
  return Math.round(XP_LEVEL_BASE * Math.pow(level, XP_LEVEL_EXPONENT));
}

export interface VitalsSnapshot {
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  level: number;
  xp: number;
  xpNeeded: number;
  skillPoints: number;
  dead: boolean;
}

export class PlayerState {
  characterId: CharacterId = 'vanguard';
  level = 1;
  xp = 0;
  skillPoints = 0;
  skillRanks: Record<string, number> = {};

  health = 100;
  shield = 50;
  dead = false;

  /** Seconds since the last damage instance, drives shield regen. */
  timeSinceDamage = 999;
  stats: DerivedStats;

  /** Temporary multipliers applied by active abilities. */
  readonly buff = {
    fireRate: 1,
    damage: 1,
    moveSpeed: 1,
    criticalChance: 0,
    criticalDamage: 1,
    spread: 1,
  };

  constructor() {
    this.stats = deriveStats(this.characterId, this.level, this.skillRanks);
    this.health = this.stats.maxHealth;
    this.shield = this.stats.maxShield;
  }

  configure(characterId: CharacterId, level: number, ranks: Record<string, number>): void {
    this.characterId = characterId;
    this.level = clamp(level, 1, MAX_LEVEL);
    this.skillRanks = { ...ranks };
    this.recomputeStats();
    this.health = this.stats.maxHealth;
    this.shield = this.stats.maxShield;
    this.timeSinceDamage = 999;
    this.dead = false;
  }

  recomputeStats(): void {
    const previousMaxHealth = this.stats.maxHealth;
    const previousMaxShield = this.stats.maxShield;
    this.stats = deriveStats(this.characterId, this.level, this.skillRanks);
    // Gaining a max should feel like a partial heal, never a loss.
    if (this.stats.maxHealth > previousMaxHealth) {
      this.health = Math.min(this.stats.maxHealth, this.health + (this.stats.maxHealth - previousMaxHealth));
    }
    if (this.stats.maxShield > previousMaxShield) {
      this.shield = Math.min(this.stats.maxShield, this.shield + (this.stats.maxShield - previousMaxShield));
    }
    this.health = clamp(this.health, 0, this.stats.maxHealth);
    this.shield = clamp(this.shield, 0, this.stats.maxShield);
  }

  get xpNeeded(): number {
    return this.level >= MAX_LEVEL ? 0 : xpRequiredForLevel(this.level);
  }

  get effectiveCriticalChance(): number {
    return clamp(this.stats.criticalChance + this.buff.criticalChance, 0, 0.95);
  }

  get effectiveCriticalDamage(): number {
    return this.stats.criticalDamage * this.buff.criticalDamage;
  }

  /** Applies damage to shields first, then health. Returns true if it killed. */
  applyDamage(amount: number): boolean {
    if (this.dead || amount <= 0) return false;
    this.timeSinceDamage = 0;

    const resisted = amount * (1 - this.stats.damageResist);
    let remaining = resisted;

    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (this.shield <= 0.01) {
        this.shield = 0;
        bus.emit(GameEvents.PlayerShieldBreak, {});
      }
    }

    if (remaining > 0) {
      this.health = Math.max(0, this.health - remaining);
    }

    bus.emit(GameEvents.PlayerDamaged, { amount: resisted, health: this.health, shield: this.shield });

    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      bus.emit(GameEvents.PlayerDied, {});
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    if (this.dead) return;
    const before = this.health;
    this.health = clamp(this.health + amount, 0, this.stats.maxHealth);
    if (this.health > before) bus.emit(GameEvents.PlayerHealed, { amount: this.health - before });
  }

  restoreShields(): void {
    this.shield = this.stats.maxShield;
  }

  revive(): void {
    this.dead = false;
    this.health = this.stats.maxHealth;
    this.shield = this.stats.maxShield;
    this.timeSinceDamage = 999;
  }

  addXp(amount: number): number {
    if (this.level >= MAX_LEVEL) return 0;
    this.xp += Math.max(0, Math.round(amount));
    let gained = 0;
    while (this.level < MAX_LEVEL && this.xp >= this.xpNeeded) {
      this.xp -= this.xpNeeded;
      this.level += 1;
      this.skillPoints += 1;
      gained += 1;
    }
    if (gained > 0) {
      this.recomputeStats();
      this.health = this.stats.maxHealth;
      this.shield = this.stats.maxShield;
      bus.emit(GameEvents.PlayerLevelUp, { level: this.level, skillPoints: this.skillPoints });
    }
    bus.emit(GameEvents.SkillPointChanged, { points: this.skillPoints });
    return gained;
  }

  update(dt: number): void {
    this.timeSinceDamage += dt;
    if (this.dead) return;
    const delay = SHIELD_REGEN_DELAY * this.stats.shieldRegenDelayMult;
    if (this.timeSinceDamage < delay) return;
    if (this.shield >= this.stats.maxShield) return;
    const before = this.shield;
    this.shield = Math.min(this.stats.maxShield, this.shield + SHIELD_REGEN_RATE * dt);
    if (before <= 0.01 && this.shield > 0.01) {
      bus.emit(GameEvents.PlayerShieldStart, {});
    }
  }

  snapshot(): VitalsSnapshot {
    return {
      health: this.health,
      maxHealth: this.stats.maxHealth,
      shield: this.shield,
      maxShield: this.stats.maxShield,
      level: this.level,
      xp: this.xp,
      xpNeeded: this.xpNeeded,
      skillPoints: this.skillPoints,
      dead: this.dead,
    };
  }
}
