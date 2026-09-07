import type { Rarity } from '../../../shared/types';
import { RARITY_COLORS, RARITY_LABELS, WEAPON_TYPE_LABELS } from '../../../shared/constants';
import type { WeaponController } from '../../game/weapons/WeaponController';
import type { PlayerState } from '../../game/player/PlayerState';
import type { LootFocusPayload } from '../../game/loot/LootSystem';
import { bus, GameEvents } from '../../game/core/EventBus';
import { byId, clear, make, setBar, show } from '../dom';

/**
 * The in-game HUD. Everything is imperative DOM updates against the static
 * markup in index.html — no framework, no per-frame allocation.
 */

interface NoticeOptions {
  tone?: 'default' | 'rare' | 'epic' | 'legendary' | 'warn';
  sub?: string;
  duration?: number;
}

interface AbilityHud {
  root: HTMLElement;
  name: HTMLElement | null;
  cd: HTMLElement | null;
}

export class Hud {
  private root = byId('hud');
  private objective = byId('objective-text');
  private objectiveProgress = byId('objective-progress');

  private healthBar = byId('bar-health');
  private healthText = byId('text-health');
  private shieldBar = byId('bar-shield');
  private shieldText = byId('text-shield');
  private xpBar = byId('bar-xp');
  private xpText = byId('text-xp');
  private levelText = byId('vitals-level');
  private nameText = byId('vitals-name');

  private weaponName = byId('weapon-name');
  private weaponType = byId('weapon-type');
  private ammoMag = byId('ammo-mag');
  private ammoReserve = byId('ammo-reserve');
  private reloadHint = byId('reload-hint');
  private slotsRow = byId('weapon-slots');

  private interact = byId('hud-interact');
  private interactLabel = byId('interact-label');

  private hitmarker = byId('hitmarker');
  private damageFlash = byId('hud-damage-flash');
  private notifications = byId('hud-notifications');

  private bossRoot = byId('hud-boss');
  private bossName = byId('boss-name');
  private bossHealth = byId('bar-boss-health');
  private bossShield = byId('bar-boss-shield');

  private abilityF: AbilityHud = {
    root: byId('ability-f') ?? make('div'),
    name: byId('ability-f-name'),
    cd: byId('ability-f-cd'),
  };
  private abilityQ: AbilityHud = {
    root: byId('ability-q') ?? make('div'),
    name: byId('ability-q-name'),
    cd: byId('ability-q-cd'),
  };

  private levelUpBanner = byId('levelup-banner');
  private levelUpLevel = byId('levelup-level');
  private levelUpSub = byId('levelup-sub');

  private slotCards: HTMLElement[] = [];
  private notices: { node: HTMLElement; expires: number }[] = [];
  private hitTimeout = 0;
  private flashTimeout = 0;
  private lastSlotSignature = '';
  private now = 0;

  constructor(
    private player: PlayerState,
    private weapons: WeaponController,
  ) {
    this.bind();
  }

  private bind(): void {
    bus.on(GameEvents.EnemyDamaged, (payload: { critical?: boolean; headshot?: boolean; killed?: boolean }) => {
      this.flashHitmarker(payload.critical === true || payload.headshot === true);
    });
    bus.on(GameEvents.PlayerDamaged, () => this.flashDamage());
    bus.on(GameEvents.PlayerShieldBreak, () => this.notify('SHIELD DOWN', { tone: 'warn', duration: 1.6 }));
    bus.on(GameEvents.PlayerLevelUp, (payload: { level: number; skillPoints: number }) => {
      this.showLevelUp(payload.level, payload.skillPoints);
    });
    bus.on(GameEvents.QuestUpdated, (payload: { objective: string; progress: string }) => {
      this.setObjective(payload.objective, payload.progress);
    });
    bus.on(GameEvents.ObjectiveReached, (payload: { text?: string; label?: string; cleared?: boolean }) => {
      const text = payload.text ?? (payload.cleared ? `${payload.label} cleared` : 'Objective reached');
      this.notify(text, { sub: 'OBJECTIVE', duration: 3 });
    });
    bus.on(GameEvents.BossSpawned, (payload: { name: string }) => {
      this.setBoss(payload.name, 1, 1, true);
      this.notify(payload.name, { tone: 'warn', sub: 'MINI-BOSS ENGAGED', duration: 3.6 });
    });
    bus.on(GameEvents.BossPhase, (payload: { phase: number }) => {
      this.notify(payload.phase === 2 ? 'TITAN OVERDRIVE' : 'PHASE 1', { tone: 'warn', duration: 2.6 });
    });
    bus.on(GameEvents.BossKilled, () => {
      this.setBoss('', 0, 0, false);
      this.notify('SCRAP TITAN DOWN', { tone: 'legendary', sub: 'SALVAGE SECURED', duration: 4 });
    });
    bus.on(GameEvents.LootDropped, (payload: { rarity: Rarity; name: string; kind: string }) => {
      if (payload.kind !== 'weapon') return;
      if (payload.rarity === 'rare' || payload.rarity === 'epic' || payload.rarity === 'legendary') {
        this.notify(payload.name, { tone: payload.rarity, sub: `${RARITY_LABELS[payload.rarity]} DROP`, duration: 3 });
      }
    });
    bus.on(GameEvents.QuestCompleted, (payload: { name: string }) => {
      this.notify(`${payload.name} COMPLETE`, { tone: 'legendary', duration: 5 });
    });
  }

  setVisible(isVisible: boolean): void {
    if (this.root) this.root.classList.toggle('hidden', !isVisible);
  }

  setCharacterName(name: string): void {
    if (this.nameText) this.nameText.textContent = name.toUpperCase();
  }

  setAbilityNames(f: string, q: string): void {
    if (this.abilityF.name) this.abilityF.name.textContent = f;
    if (this.abilityQ.name) this.abilityQ.name.textContent = q;
  }

  setObjective(text: string, progress = ''): void {
    if (this.objective) this.objective.textContent = text;
    if (this.objectiveProgress) {
      this.objectiveProgress.textContent = progress;
      show(this.objectiveProgress, progress.length > 0);
    }
  }

  private flashHitmarker(critical: boolean): void {
    const marker = this.hitmarker;
    if (!marker) return;
    marker.classList.add('on');
    marker.classList.toggle('crit', critical);
    window.clearTimeout(this.hitTimeout);
    this.hitTimeout = window.setTimeout(() => {
      marker.classList.remove('on', 'crit');
    }, 110);
  }

  private flashDamage(): void {
    const flash = this.damageFlash;
    if (!flash) return;
    flash.classList.add('on');
    window.clearTimeout(this.flashTimeout);
    this.flashTimeout = window.setTimeout(() => flash.classList.remove('on'), 130);
  }

  notify(text: string, options: NoticeOptions = {}): void {
    const layer = this.notifications;
    if (!layer) return;
    const node = make('div', `note ${options.tone ?? 'default'}`);
    node.append(make('span', undefined, text));
    if (options.sub) node.append(make('small', undefined, options.sub));
    layer.append(node);
    this.notices.push({ node, expires: this.now + (options.duration ?? 3.4) });
    // Cap the stack so a big fight cannot flood the corner.
    while (this.notices.length > 5) {
      const oldest = this.notices.shift();
      oldest?.node.remove();
    }
  }

  private showLevelUp(level: number, points: number): void {
    const banner = this.levelUpBanner;
    if (!banner) return;
    if (this.levelUpLevel) this.levelUpLevel.textContent = String(level);
    if (this.levelUpSub) this.levelUpSub.textContent = `+${points} SKILL POINT${points === 1 ? '' : 'S'} · VITALS RESTORED`;
    show(banner, true);
    window.setTimeout(() => show(banner, false), 3200);
    this.notify(`LEVEL ${level}`, { sub: 'PROGRESSION', duration: 3 });
  }

  setBoss(name: string, healthRatio: number, shieldRatio: number, active: boolean): void {
    if (!this.bossRoot) return;
    show(this.bossRoot, active);
    if (!active) return;
    if (this.bossName) this.bossName.textContent = name.toUpperCase();
    setBar(this.bossHealth, null, healthRatio);
    setBar(this.bossShield, null, shieldRatio);
  }

  setInteraction(payload: LootFocusPayload | null): void {
    if (!this.interact) return;
    show(this.interact, payload !== null);
    if (!payload || !this.interactLabel) return;
    this.interactLabel.textContent = payload.kind === 'weapon' ? `Pick up ${payload.label}` : payload.label;
    this.interact.style.color = RARITY_COLORS[payload.rarity] ?? '';
  }

  setAiming(isAiming: boolean): void {
    if (this.root) this.root.classList.toggle('aiming', isAiming);
  }

  /** Called every frame while playing. */
  update(dt: number, abilityCooldowns: { f: number; fTotal: number; q: number; qTotal: number; fActive: boolean }): void {
    this.now += dt;

    const vitals = this.player.snapshot();
    setBar(this.healthBar, this.healthText, vitals.health / Math.max(1, vitals.maxHealth), `${Math.ceil(vitals.health)}`);
    setBar(this.shieldBar, this.shieldText, vitals.shield / Math.max(1, vitals.maxShield), `${Math.ceil(vitals.shield)}`);
    if (this.levelText) this.levelText.textContent = String(vitals.level);
    if (vitals.xpNeeded === 0) {
      setBar(this.xpBar, this.xpText, 1, 'MAX LEVEL');
    } else {
      setBar(this.xpBar, this.xpText, vitals.xp / vitals.xpNeeded, `${vitals.xp} / ${vitals.xpNeeded} XP`);
    }

    const hud = this.weapons.hudState;
    if (this.weaponName) {
      this.weaponName.textContent = hud.name;
      this.weaponName.style.color = RARITY_COLORS[hud.rarity] ?? '';
    }
    if (this.weaponType) {
      this.weaponType.textContent = `${WEAPON_TYPE_LABELS[hud.type] ?? hud.type} · ${RARITY_LABELS[hud.rarity] ?? ''} · LV ${hud.level}`;
    }
    if (this.ammoMag) {
      this.ammoMag.textContent = String(hud.ammo);
      this.ammoMag.parentElement?.classList.toggle('low', hud.ammo <= hud.magazine * 0.25);
    }
    if (this.ammoReserve) this.ammoReserve.textContent = `/ ${hud.reserve}`;
    if (this.reloadHint) show(this.reloadHint, hud.reloading);
    if (this.reloadHint && hud.reloading) {
      this.reloadHint.textContent = `RELOADING ${Math.round(this.weapons.reloadProgress * 100)}%`;
    }

    this.renderSlotCards();
    this.renderAbilities(abilityCooldowns);

    for (let i = this.notices.length - 1; i >= 0; i--) {
      const entry = this.notices[i];
      if (!entry) continue;
      if (this.now >= entry.expires) {
        entry.node.remove();
        this.notices.splice(i, 1);
      }
    }
  }

  private renderSlotCards(): void {
    const row = this.slotsRow;
    if (!row) return;
    const slots = this.weapons.slots;
    const signature = slots.map((weapon) => (weapon ? `${weapon.id}:${weapon.ammo}` : 'empty')).join('|') + `#${this.weapons.activeSlot}`;
    if (signature === this.lastSlotSignature) return;
    this.lastSlotSignature = signature;

    clear(row);
    this.slotCards = [];
    slots.forEach((weapon, index) => {
      const card = make('div', `wslot${index === this.weapons.activeSlot ? ' on' : ''}${weapon ? '' : ' empty'}`);
      card.append(make('i', undefined, String(index + 1)));
      card.append(make('span', undefined, weapon ? shortWeaponName(weapon.weaponType) : '—'));
      if (weapon) card.style.borderColor = `${RARITY_COLORS[weapon.rarity]}66`;
      row.append(card);
      this.slotCards.push(card);
    });
  }

  private renderAbilities(cooldowns: { f: number; fTotal: number; q: number; qTotal: number; fActive: boolean }): void {
    applyCooldown(this.abilityF, cooldowns.f, cooldowns.fTotal, cooldowns.fActive);
    applyCooldown(this.abilityQ, cooldowns.q, cooldowns.qTotal, false);
  }

  dispose(): void {
    bus.offOwner(this);
    window.clearTimeout(this.hitTimeout);
    window.clearTimeout(this.flashTimeout);
  }
}

function applyCooldown(hud: AbilityHud, remaining: number, total: number, active: boolean): void {
  hud.root.classList.toggle('ready', remaining <= 0);
  hud.root.classList.toggle('active', active);
  hud.root.classList.toggle('muted', total > 0 && remaining > 0);
  if (!hud.cd) return;
  if (remaining > 0) {
    show(hud.cd, true);
    hud.cd.style.height = `${(remaining / Math.max(0.001, total)) * 100}%`;
    hud.cd.title = `${remaining.toFixed(1)}s`;
  } else {
    show(hud.cd, false);
  }
}

function shortWeaponName(type: string): string {
  const labels: Record<string, string> = {
    pistol: 'PSL',
    assault_rifle: 'AR',
    shotgun: 'SG',
    sniper_rifle: 'SNP',
    smg: 'SMG',
  };
  return labels[type] ?? type.slice(0, 3).toUpperCase();
}
