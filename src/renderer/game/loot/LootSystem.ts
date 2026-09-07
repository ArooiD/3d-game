import * as THREE from 'three';
import type { Rarity, Weapon } from '../../../shared/types';
import { RARITY_COLORS, RARITY_HEX, RARITY_LABELS } from '../../../shared/constants';
import { INTERACT_RANGE, PICKUP_VALUES } from '../../data/loot/drops';
import { audio, SoundName } from '../audio/AudioSystem';
import { bus, GameEvents } from '../core/EventBus';
import { rng } from '../core/Rng';
import { createLootVisual, type LootVisual } from '../effects/EffectsSystem';

/**
 * Ground loot: physical items with a rarity beam, a comparison tooltip and an
 * E-to-interact prompt. Weapons, health, shields and salvage share one entity
 * so the interaction code stays single-pass.
 */

export type PickupKind = 'weapon' | 'health' | 'shield' | 'currency';

export interface LootItem {
  id: string;
  kind: PickupKind;
  position: THREE.Vector3;
  visual: LootVisual;
  weapon?: Weapon;
  amount: number;
  rarity: Rarity;
  /** Seconds before despawn; 0 means it never expires. */
  ttl: number;
  questItem: boolean;
  targetId?: string;
}

export interface ComparisonRow {
  label: string;
  value: string;
  /** Positive is better; drives the green/red arrow. */
  delta: number;
  deltaText: string;
}

export interface LootFocusPayload {
  id: string;
  kind: PickupKind;
  label: string;
  weapon?: Weapon;
  comparison: ComparisonRow[];
  rarity: Rarity;
}

let lootCounter = 0;

export class LootSystem {
  readonly items: LootItem[] = [];
  private focused: LootItem | null = null;
  private time = 0;

  constructor(
    private scene: THREE.Scene,
    private groundY: (x: number, z: number) => number,
  ) {}

  dropWeapon(
    weapon: Weapon,
    position: THREE.Vector3,
    options: { questItem?: boolean; targetId?: string; ttl?: number } = {},
  ): LootItem {
    const item = this.createItem({
      kind: 'weapon',
      position,
      weapon,
      rarity: weapon.rarity,
      ttl: options.ttl ?? 0,
      questItem: options.questItem ?? false,
      targetId: options.targetId,
    });
    bus.emit(GameEvents.LootDropped, {
      id: item.id,
      kind: 'weapon',
      position: position.clone(),
      rarity: weapon.rarity,
      name: weapon.name,
    });
    return item;
  }

  dropConsumable(kind: 'health' | 'shield' | 'currency', position: THREE.Vector3, amount: number, rarity: Rarity = 'common'): LootItem {
    const item = this.createItem({ kind, position, amount, rarity, ttl: 45 });
    bus.emit(GameEvents.LootDropped, { id: item.id, kind, position: position.clone(), rarity, name: kind });
    return item;
  }

  private createItem(options: {
    kind: PickupKind;
    position: THREE.Vector3;
    weapon?: Weapon;
    amount?: number;
    rarity: Rarity;
    ttl: number;
    questItem?: boolean;
    targetId?: string;
  }): LootItem {
    const visual = createLootVisual(options.rarity, options.weapon ?? null);
    const ground = this.groundY(options.position.x, options.position.z);
    const position = new THREE.Vector3(options.position.x, ground + 0.35, options.position.z);
    visual.group.position.copy(position);
    visual.group.rotation.y = rng.angle();
    this.scene.add(visual.group);

    const item: LootItem = {
      id: `loot_${lootCounter++}`,
      kind: options.kind,
      position,
      visual,
      weapon: options.weapon,
      amount: options.amount ?? 0,
      rarity: options.rarity,
      ttl: options.ttl,
      questItem: options.questItem ?? false,
      targetId: options.targetId,
    };
    this.items.push(item);
    return item;
  }

  get focusTarget(): LootItem | null {
    return this.focused;
  }

  clear(): void {
    for (const item of this.items) {
      item.visual.dispose();
      item.visual.group.removeFromParent();
    }
    this.items.length = 0;
    this.focused = null;
  }

  remove(item: LootItem): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
    item.visual.dispose();
    item.visual.group.removeFromParent();
    if (this.focused === item) {
      this.focused = null;
      bus.emit(GameEvents.LootFocused, { payload: null });
    }
  }

  /** Comparison rows for the ground tooltip, measured against what is worn. */
  static compare(candidate: Weapon, equipped: (Weapon | null)[]): ComparisonRow[] {
    const baseline = equipped.find((entry) => entry !== null) ?? null;
    const rows: ComparisonRow[] = [];

    const push = (
      label: string,
      value: number,
      base: number | undefined,
      digits = 0,
      invert = false,
      suffix = '',
    ): void => {
      const text = digits === 0 ? `${Math.round(value)}${suffix}` : `${value.toFixed(digits)}${suffix}`;
      if (base === undefined) {
        rows.push({ label, value: text, delta: 0, deltaText: '' });
        return;
      }
      const raw = invert ? base - value : value - base;
      const rounded = digits === 0 ? Math.round(raw) : Number(raw.toFixed(digits));
      const shown = digits === 0 ? `${Math.round(rounded)}` : rounded.toFixed(digits);
      rows.push({
        label,
        value: text,
        delta: rounded,
        deltaText: rounded === 0 ? '—' : `${rounded > 0 ? '+' : ''}${shown}${suffix}`,
      });
    };

    push('Damage', effectiveDamage(candidate), baseline ? effectiveDamage(baseline) : undefined);
    push('Fire Rate', candidate.fireRate, baseline?.fireRate, 1, false, '/s');
    push('Magazine', candidate.magazineSize, baseline?.magazineSize);
    push('Crit Damage', candidate.criticalMultiplier * 100, baseline ? baseline.criticalMultiplier * 100 : undefined, 0, false, '%');
    push('Reload', candidate.reloadTime, baseline?.reloadTime, 2, true, 's');
    return rows;
  }

  describe(item: LootItem, equipped: (Weapon | null)[]): LootFocusPayload {
    if (item.kind === 'weapon' && item.weapon) {
      return {
        id: item.id,
        kind: item.kind,
        label: item.weapon.name,
        weapon: item.weapon,
        comparison: LootSystem.compare(item.weapon, equipped),
        rarity: item.weapon.rarity,
      };
    }
    const labels: Record<string, string> = {
      health: `Repair Kit  +${item.amount} HP`,
      shield: `Shield Cell  +${item.amount}`,
      currency: `Salvage x${item.amount}`,
    };
    return {
      id: item.id,
      kind: item.kind,
      label: labels[item.kind] ?? 'Salvage',
      comparison: [],
      rarity: item.rarity,
    };
  }

  update(dt: number, playerPosition: THREE.Vector3, equipped: (Weapon | null)[]): LootFocusPayload | null {
    this.time += dt;

    let best: LootItem | null = null;
    let bestDistance = INTERACT_RANGE;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item) continue;

      if (!item.questItem && item.ttl > 0) {
        item.ttl -= dt;
        if (item.ttl <= 0) {
          this.remove(item);
          continue;
        }
        item.visual.group.visible = !(item.ttl < 6 && Math.sin(item.ttl * 12) > 0);
      }

      // Spin the gun/gem, bob the whole pickup.
      item.visual.spinner.rotation.y += dt * 1.7;
      item.visual.group.position.y = item.position.y + Math.sin(this.time * 2 + item.position.x) * 0.07;

      const flat = Math.hypot(item.position.x - playerPosition.x, item.position.z - playerPosition.z);
      const vertical = Math.abs(item.position.y - (playerPosition.y + 0.9));
      if (flat < bestDistance && vertical < 3.4) {
        best = item;
        bestDistance = flat;
      }
    }

    if (best !== this.focused) {
      this.focused?.visual.setHighlight(false);
      this.focused = best;
      if (best) {
        best.visual.setHighlight(true);
        audio.play(SoundName.UISelect, 0.3, 140);
      }
      const payload = best ? this.describe(best, equipped) : null;
      bus.emit(GameEvents.LootFocused, { payload });
    }

    return best ? this.describe(best, equipped) : null;
  }

  /** Consumes an item and reports what it granted. */
  pickup(item: LootItem): { kind: PickupKind; weapon?: Weapon; amount: number } {
    const result = { kind: item.kind, weapon: item.weapon, amount: item.amount };
    const rarity = item.kind === 'weapon' && item.weapon ? item.weapon.rarity : 'common';
    this.remove(item);
    audio.play(isHighRarity(rarity) ? SoundName.LootRare : SoundName.LootPickup);
    bus.emit(GameEvents.LootPicked, { kind: result.kind, weapon: result.weapon, amount: result.amount, rarity });
    return result;
  }

  static pickupValue(kind: PickupKind, amount: number): number {
    if (kind === 'health') return amount || PICKUP_VALUES.health;
    if (kind === 'shield') return amount || PICKUP_VALUES.shield;
    return amount;
  }

  static rarityColor(rarity: string): string {
    return RARITY_COLORS[rarity] ?? '#ffffff';
  }

  static rarityHexValue(rarity: string): number {
    return RARITY_HEX[rarity] ?? 0xffffff;
  }

  static rarityLabel(rarity: string): string {
    return RARITY_LABELS[rarity] ?? rarity;
  }

  dispose(): void {
    this.clear();
  }
}

function isHighRarity(rarity: string): boolean {
  return rarity === 'rare' || rarity === 'epic' || rarity === 'legendary';
}

/** Total per-shot damage including pellets, for fair comparisons. */
export function effectiveDamage(weapon: Weapon): number {
  return weapon.damage * Math.max(1, weapon.pellets ?? 1);
}
