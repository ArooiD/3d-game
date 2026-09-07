import { RARITY_COLORS, RARITY_LABELS, WEAPON_TYPE_LABELS } from '../../../shared/constants';
import type { Weapon } from '../../../shared/types';
import type { LootFocusPayload } from '../../game/loot/LootSystem';
import { bus, GameEvents } from '../../game/core/EventBus';
import { byId, clear, make } from '../dom';

/**
 * Ground-item tooltip: name, rarity, stats and a live comparison against what
 * the player currently has equipped. Follows nothing on screen — it is pinned
 * under the crosshair, which reads better in a pointer-locked FPS.
 */

export class LootTooltip {
  private layer = byId('world-overlay');
  private node: HTMLElement | null = null;
  private currentId: string | null = null;

  constructor() {
    bus.on(GameEvents.LootFocused, (payload: { payload: LootFocusPayload | null }) => {
      this.render(payload.payload);
    });
  }

  private ensureNode(): HTMLElement {
    if (this.node) return this.node;
    const node = make('div', 'loot-tip hidden');
    this.layer?.append(node);
    this.node = node;
    return node;
  }

  render(payload: LootFocusPayload | null): void {
    if (!payload) {
      if (this.node) this.node.classList.add('hidden');
      this.currentId = null;
      return;
    }
    const node = this.ensureNode();
    if (this.currentId === payload.id && node.dataset.built === payload.id) return;
    this.currentId = payload.id;
    node.dataset.built = payload.id;

    clear(node);
    const color = RARITY_COLORS[payload.rarity] ?? '#ffffff';
    node.style.borderColor = `${color}88`;

    const title = make('h4');
    title.textContent = payload.label;
    title.style.color = color;
    node.append(title);

    if (payload.weapon) {
      const meta = make('div', 't-rar');
      meta.textContent = `${RARITY_LABELS[payload.rarity] ?? payload.rarity} · ${WEAPON_TYPE_LABELS[payload.weapon.weaponType] ?? payload.weapon.weaponType} · LV ${payload.weapon.level}`;
      meta.style.color = color;
      node.append(meta);

      const table = make('table', 'cmp');
      const body = make('tbody');
      for (const row of payload.comparison) {
        const tr = make('tr');
        tr.append(make('td', undefined, row.label));
        tr.append(make('td', undefined, row.value));
        const deltaClass = row.delta > 0 ? 'up' : row.delta < 0 ? 'down' : 'same';
        const arrow = row.delta > 0 ? ' ▲ ' : row.delta < 0 ? ' ▼ ' : ' ';
        tr.append(make('td', deltaClass, `${row.deltaText}${arrow}`));
        body.append(tr);
      }
      table.append(body);
      node.append(table);

      if (payload.weapon.modifiers.length > 0) {
        const mods = make('div', 'mods');
        for (const modifier of payload.weapon.modifiers) {
          mods.append(make('div', 'mod', `• ${modifier.label}`));
        }
        node.append(mods);
      }
    }

    const hint = make('div', 't-hint');
    hint.textContent = payload.kind === 'weapon' ? 'press E to pick up' : 'press E to use';
    node.append(hint);

    node.classList.remove('hidden');
  }

  /** Keeps the tooltip anchored near the crosshair while focused. */
  setWeaponPreview(weapon: Weapon | null): void {
    if (!this.node || !weapon) return;
    this.node.style.opacity = '1';
  }

  hide(): void {
    if (this.node) this.node.classList.add('hidden');
    this.currentId = null;
  }

  dispose(): void {
    this.node?.remove();
    this.node = null;
  }
}
