import type { ModifierStat, WeaponModifier } from '../../../shared/types';

/**
 * Modifier pool used by the procedural weapon generator. Each entry declares how
 * it rolls and how it should be labelled in the UI.
 */

export interface ModifierTemplate {
  stat: ModifierStat;
  label: string;
  /** Roll range as a fraction delta, e.g. 0.15 = +15%. */
  min: number;
  max: number;
  /** Flat additive roll instead of a percentage (projectiles). */
  flat?: boolean;
  /** Negative rolls are desirable for these (reload time, recoil). */
  invert?: boolean;
  /** Only offered to these weapon types; empty = any. */
  types?: string[];
  weight: number;
}

export const MODIFIER_TEMPLATES: ModifierTemplate[] = [
  { stat: 'damage', label: 'Damage', min: 0.08, max: 0.28, weight: 10 },
  { stat: 'fireRate', label: 'Fire Rate', min: 0.06, max: 0.22, weight: 8 },
  { stat: 'magazineSize', label: 'Magazine', min: 0.12, max: 0.4, weight: 8 },
  { stat: 'reloadTime', label: 'Reload Speed', min: -0.32, max: -0.12, invert: true, weight: 7 },
  { stat: 'accuracy', label: 'Accuracy', min: 0.06, max: 0.2, weight: 7 },
  { stat: 'recoil', label: 'Recoil Control', min: -0.4, max: -0.15, invert: true, weight: 6 },
  { stat: 'criticalMultiplier', label: 'Critical Damage', min: 0.15, max: 0.5, weight: 8 },
  { stat: 'shieldDamage', label: 'Shield Breaker', min: 0.2, max: 0.6, weight: 5 },
  { stat: 'range', label: 'Range', min: 0.15, max: 0.4, weight: 4 },
  { stat: 'projectiles', label: 'Extra Projectile', min: 1, max: 2, flat: true, types: ['shotgun'], weight: 6 },
  { stat: 'projectiles', label: 'Split Shot', min: 1, max: 1, flat: true, types: ['pistol', 'smg'], weight: 3 },
];

/** Turns a rolled template into the final modifier record. */
export function buildModifier(stat: ModifierStat, label: string, value: number, flat: boolean): WeaponModifier {
  const pct = Math.round(value * 100);
  let text: string;
  if (flat) {
    text = `${pct > 0 ? '+' : ''}${Math.round(value)} ${label}`;
  } else {
    const sign = pct >= 0 ? '+' : '';
    // For inverted stats a negative roll is a gain, so phrase it as a bonus.
    text = `${sign}${pct}% ${label}`;
  }
  return { stat, value, label: text };
}

export function formatPercent(value: number): string {
  const pct = Math.round(value * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}
