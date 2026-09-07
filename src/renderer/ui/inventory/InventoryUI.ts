import { RARITY_COLORS, RARITY_LABELS, WEAPON_TYPE_LABELS, INVENTORY_SLOTS } from '../../../shared/constants';
import type { Weapon } from '../../../shared/types';
import { CHARACTERS } from '../../data/characters/characters';
import { bus, GameEvents } from '../../game/core/EventBus';
import { LootSystem } from '../../game/loot/LootSystem';
import type { PlayerState } from '../../game/player/PlayerState';
import type { WeaponController } from '../../game/weapons/WeaponController';
import { byId, clear, make, percent } from '../dom';

/**
 * Inventory panel: three equipped slots plus a 20-slot backpack, with an
 * inspect column that compares the selected weapon against the equipped one and
 * offers equip / drop / destroy.
 */

export interface InventoryHost {
  backpack: Weapon[];
  equipFromInventory(index: number): void;
  dropFromInventory(index: number): void;
  destroyFromInventory(index: number): void;
  unequipSlot(slot: number, drop?: boolean): void;
  addSalvage(amount: number): void;
  salvage: number;
}

export class InventoryUI {
  private root = byId('ui-inventory');
  private characterPanel = byId('inv-character');
  private equippedRow = byId('inv-equipped');
  private grid = byId('inv-grid');
  private detail = byId('inv-detail');
  private count = byId('inv-count');

  private selected: { where: 'bag' | 'slot'; index: number } | null = null;

  constructor(
    private player: PlayerState,
    private weapons: WeaponController,
    private host: InventoryHost,
  ) {}

  get isOpen(): boolean {
    return this.root !== null && !this.root.classList.contains('hidden');
  }

  setVisible(isVisible: boolean): void {
    if (!this.root) return;
    this.root.classList.toggle('hidden', !isVisible);
    if (isVisible) this.render();
  }

  private signature(): string {
    const bag = this.host.backpack.map((weapon) => weapon.id).join(',');
    const slots = this.weapons.slots.map((weapon) => weapon?.id ?? '-').join(',');
    return `${bag}|${slots}|${this.player.level}|${this.host.salvage}`;
  }

  private lastSignature = '';

  render(force = false): void {
    if (!this.isOpen && !force) return;
    const signature = `${this.signature()}|${this.selected ? `${this.selected.where}${this.selected.index}` : ''}`;
    if (signature === this.lastSignature && !force) return;
    this.lastSignature = signature;

    this.renderCharacter();
    this.renderEquipped();
    this.renderGrid();
    this.renderDetail();
  }

  private renderCharacter(): void {
    if (!this.characterPanel) return;
    clear(this.characterPanel);
    const definition = CHARACTERS[this.player.characterId] ?? CHARACTERS.vanguard;
    const stats = this.player.stats;

    this.characterPanel.append(make('h3', undefined, definition.name.toUpperCase()));
    this.characterPanel.append(make('div', 'sub', `${definition.tagline} · LEVEL ${this.player.level}`));

    const kv = make('div', 'kv');
    const row = (label: string, value: string): void => {
      const line = make('div');
      line.append(make('span', undefined, label));
      line.append(make('b', undefined, value));
      kv.append(line);
    };
    row('Health', `${Math.round(stats.maxHealth)}`);
    row('Shield', `${Math.round(stats.maxShield)}`);
    row('Move / Sprint', `${stats.movementSpeed.toFixed(1)} / ${stats.sprintSpeed.toFixed(1)}`);
    row('Crit Chance', percent(this.player.effectiveCriticalChance, 1));
    row('Crit Damage', `${this.player.effectiveCriticalDamage.toFixed(2)}x`);
    row('Weapon Damage', `${Math.round(stats.weaponDamageModifier * 100)}%`);
    row('Reload Speed', `${Math.round((1 / stats.reloadTimeMult) * 100)}%`);
    row('Ability Speed', `${Math.round((1 / stats.cooldownMult) * 100)}%`);
    row('Salvage', String(this.host.salvage));
    this.characterPanel.append(kv);
  }

  private renderEquipped(): void {
    if (!this.equippedRow) return;
    clear(this.equippedRow);
    this.weapons.slots.forEach((weapon, index) => {
      const selected = this.selected?.where === 'slot' && this.selected.index === index;
      this.equippedRow?.append(this.buildCard(weapon, 'slot', index, index + 1, selected));
    });
  }

  private renderGrid(): void {
    if (!this.grid) return;
    clear(this.grid);
    const bag = this.host.backpack;
    if (this.count) this.count.textContent = `${bag.length} / ${INVENTORY_SLOTS}`;
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const weapon = bag[i];
      const selected = this.selected?.where === 'bag' && this.selected.index === i;
      this.grid.append(this.buildCard(weapon ?? null, 'bag', i, i + 1, selected));
    }
  }

  private buildCard(weapon: Weapon | null, where: 'bag' | 'slot', index: number, badge: number, selected: boolean): HTMLElement {
    const card = make('div', `slot${weapon ? '' : ' empty'}${selected ? ' sel' : ''}`);
    if (weapon) {
      card.style.borderColor = `${RARITY_COLORS[weapon.rarity]}77`;
      card.append(make('div', 's-name', weapon.name));
      card.append(
        make(
          'div',
          's-meta',
          `${RARITY_LABELS[weapon.rarity] ?? weapon.rarity} · ${WEAPON_TYPE_LABELS[weapon.weaponType] ?? weapon.weaponType} · LV ${weapon.level}`,
        ),
      );
      const stat = make('div', 's-stat');
      const dmg = Math.round(weapon.damage * Math.max(1, weapon.pellets ?? 1));
      stat.append(make('span', 's-num', String(dmg)));
      stat.append(make('span', undefined, `dmg · ${weapon.fireRate.toFixed(1)}/s · ${weapon.magazineSize} rnd`));
      card.append(stat);
    } else {
      card.append(make('div', 's-name', where === 'slot' ? `SLOT ${badge}` : 'EMPTY'));
    }
    card.addEventListener('click', () => {
      this.selected = { where, index };
      this.lastSignature = '';
      this.render(true);
    });
    return card;
  }

  private renderDetail(): void {
    if (!this.detail) return;
    clear(this.detail);

    const weapon = this.selectedWeapon();
    if (!weapon) {
      this.detail.append(make('h3', undefined, 'NO ITEM SELECTED'));
      this.detail.append(
        make('div', 'd-rar', 'Click a weapon to inspect it. E equips, X drops, DEL destroys.'),
      );
      return;
    }

    const color = RARITY_COLORS[weapon.rarity] ?? '#ffffff';
    const title = make('h3', undefined, weapon.name);
    title.style.color = color;
    this.detail.append(title);

    const meta = make('div', 'd-rar');
    meta.textContent = `${RARITY_LABELS[weapon.rarity] ?? ''} · ${WEAPON_TYPE_LABELS[weapon.weaponType] ?? ''} · LEVEL ${weapon.level}`;
    meta.style.color = color;
    this.detail.append(meta);

    const comparison = LootSystem.compare(weapon, this.weapons.slots);
    const table = make('table', 'cmp');
    const body = make('tbody');
    for (const row of comparison) {
      const tr = make('tr');
      tr.append(make('td', undefined, row.label));
      tr.append(make('td', undefined, row.value));
      const cls = row.delta > 0 ? 'up' : row.delta < 0 ? 'down' : 'same';
      const arrow = row.delta > 0 ? '▲' : row.delta < 0 ? '▼' : '—';
      tr.append(make('td', cls, `${row.deltaText} ${arrow}`));
      body.append(tr);
    }
    table.append(body);
    this.detail.append(table);

    if (weapon.modifiers.length > 0) {
      const mods = make('div', 'mods');
      for (const modifier of weapon.modifiers) {
        mods.append(make('div', 'mod', `• ${modifier.label}`));
      }
      this.detail.append(mods);
    }

    const actions = make('div', 'd-actions');
    const button = (label: string, handler: () => void, className = 'btn'): HTMLButtonElement => {
      const node = make('button', className, label);
      node.addEventListener('click', handler);
      return node;
    };

    if (this.selected?.where === 'bag') {
      actions.append(button('EQUIP', () => this.guard(() => this.host.equipFromInventory(this.selectedNumber()))));
      actions.append(button('DROP', () => this.guard(() => this.host.dropFromInventory(this.selectedNumber()))));
      actions.append(button('DESTROY', () => this.guard(() => this.host.destroyFromInventory(this.selectedNumber())), 'btn btn-danger'));
    } else {
      actions.append(button('UNEQUIP', () => this.guard(() => this.host.unequipSlot(this.selectedNumber()))));
      actions.append(button('DROP', () => this.guard(() => this.host.unequipSlot(this.selectedNumber(), true))));
    }
    this.detail.append(actions);
  }

  private guard(action: () => void): void {
    action();
    this.lastSignature = '';
    this.render(true);
    bus.emit(GameEvents.InventoryChanged, {});
  }

  private selectedNumber(): number {
    return this.selected?.index ?? 0;
  }

  private selectedWeapon(): Weapon | null {
    if (!this.selected) return null;
    if (this.selected.where === 'bag') return this.host.backpack[this.selected.index] ?? null;
    return this.weapons.slots[this.selected.index] ?? null;
  }

  /** Keyboard shortcuts while the panel is open. */
  handleKey(key: 'equip' | 'drop' | 'destroy'): void {
    const weapon = this.selectedWeapon();
    if (!weapon || !this.selected) return;
    if (this.selected.where === 'slot') {
      if (key === 'equip') return;
      this.guard(() => this.host.unequipSlot(this.selectedNumber(), key === 'drop'));
      return;
    }
    if (key === 'equip') this.guard(() => this.host.equipFromInventory(this.selectedNumber()));
    if (key === 'drop') this.guard(() => this.host.dropFromInventory(this.selectedNumber()));
    if (key === 'destroy') this.guard(() => this.host.destroyFromInventory(this.selectedNumber()));
  }

  dispose(): void {
    if (this.detail) clear(this.detail);
  }
}
