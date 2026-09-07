import type { CharacterId, SettingsState } from '../../../shared/types';
import { CHARACTER_LIST, ACTIVE_SKILLS } from '../../data/characters/characters';
import { audio } from '../../game/audio/AudioSystem';
import { bus } from '../../game/core/EventBus';
import { AppState, type AppStateName } from '../../game/core/StateManager';
import { CharacterPreview, PREVIEW_SIZE } from './CharacterPreview';
import { byId, clear, formatTime, isVisible, make, show } from '../dom';

/**
 * Every full-screen surface: main menu, character select, loading, pause,
 * settings, game over and victory. Panels are static markup from index.html;
 * only their dynamic contents are generated here.
 */

export interface MainMenuHost {
  onNewGame(): void;
  onContinue(): void;
  onCharacter(): void;
  onSettings(): void;
  onExit(): void;
  hasSave: boolean;
  saveSummary: string;
}

export interface SelectHost {
  onDeploy(characterId: CharacterId): void;
  onBack(): void;
}

export interface PauseHost {
  onResume(): void;
  onSettings(): void;
  onSave(): void;
  onMainMenu(): void;
  onExit(): void;
}

export interface SettingsHost {
  settings: SettingsState;
  changed(settings: SettingsState): void;
  onBack(): void;
}

const TIPS = [
  'Shields refill a few seconds after you stop taking damage. Break contact to reset.',
  'Right-click aims down sights and cuts your spread almost in half.',
  'Rarity is not just a colour — every extra modifier is a real stat line.',
  'Rushers close fast. Kite them into cover and let the heavy weapons do the work.',
  'Snipers expose themselves when they fire. Peek, shoot, duck.',
  'The Titan arena has pillars. Circle-strafe the missiles and shoot the gaps.',
  'Salvage a Rare early and the rest of the run gets much easier.',
  'Firing from the air is inaccurate. Land before you take the shot.',
];

export class ScreensUI {
  readonly menu = byId('ui-menu');
  readonly select = byId('ui-select');
  readonly loading = byId('ui-loading');
  readonly pause = byId('ui-pause');
  readonly settings = byId('ui-settings');
  readonly gameover = byId('ui-gameover');
  readonly victory = byId('ui-victory');
  readonly error = byId('ui-error');
  readonly errorText = byId('ui-error-text');
  private toastLayer = byId('ui-toast');

  private menuDetail = byId('menu-detail');
  private continueButton = byId<HTMLButtonElement>('btn-continue');
  private selectGrid = byId('select-grid');
  private selectConfirm = byId<HTMLButtonElement>('btn-select-confirm');
  private loadingBar = byId('loading-bar');
  private loadingStep = byId('loading-step');
  private loadingTitle = byId('loading-title');
  private loadingTip = byId('loading-tip');
  private pauseStats = byId('pause-stats');
  private settingsBody = byId('settings-body');
  private victoryBody = byId('victory-body');
  private gameoverSub = byId('gameover-sub');

  private chosen: CharacterId | null = null;
  private bound = false;
  private previews = new CharacterPreview();
  private canvases = new Map<CharacterId, HTMLCanvasElement>();

  constructor(
    private hosts: {
      menu: MainMenuHost;
      select: SelectHost;
      pause: PauseHost;
      settings: SettingsHost;
    },
  ) {
    this.buildCharacterCards();
    this.bindButtons();
    this.bindStateChanges();
  }

  // ------------------------------------------------------------- visibility

  /**
   * Full-screen panels are owned by whatever opened them, but gameplay can
   * resume from several of them (loading finished, respawn, resume, keep
   * playing) without going through a show*() call. Listening for the transitions
   * back into the un-obscured states keeps a panel from being left over the live
   * world.
   */
  private bindStateChanges(): void {
    bus.on('state:changed', (payload: { to: AppStateName }) => {
      if (payload.to === AppState.Playing || payload.to === AppState.Inventory || payload.to === AppState.Skills) {
        this.hideAll();
      }
    }, this);
  }

  dispose(): void {
    this.previews.dispose();
    this.canvases.clear();
    bus.offOwner(this);
  }

  hideAll(): void {
    for (const node of [this.menu, this.select, this.loading, this.pause, this.settings, this.gameover, this.victory]) {
      if (node) show(node, false);
    }
    // Nothing is visible, so nothing needs to be drawn.
    this.previews.setActive(null);
  }

  showMenu(): void {
    this.hideAll();
    if (this.menu) show(this.menu, true);
    if (this.continueButton) {
      this.continueButton.disabled = !this.hosts.menu.hasSave;
      this.continueButton.title = this.hosts.menu.hasSave ? '' : 'no save found';
    }
    if (this.menuDetail) {
      clear(this.menuDetail);
      if (this.hosts.menu.hasSave) {
        this.menuDetail.append(make('h3', undefined, 'LAST OPERATOR'));
        for (const line of this.hosts.menu.saveSummary.split('\n')) {
          const row = make('div', 'row');
          const [label, value] = line.split(':');
          row.append(make('span', undefined, `${label ?? ''} `));
          row.append(make('b', undefined, value ?? ''));
          this.menuDetail.append(row);
        }
      } else {
        this.menuDetail.append(make('h3', undefined, 'BRIEFING'));
        this.menuDetail.append(
          make(
            'div',
            undefined,
            'A salvage drop on the Dustfall ridge went quiet. One operator, one outpost, one prototype worth the trip. Work east through the camp, the canyon and the refinery, then take the Titan.',
          ),
        );
      }
    }
  }

  showSelect(): void {
    this.hideAll();
    if (this.select) show(this.select, true);
    this.chosen = null;
    if (this.selectConfirm) this.selectConfirm.disabled = true;
    for (const card of Array.from(this.selectGrid?.querySelectorAll('.char-card') ?? [])) {
      card.classList.remove('sel');
    }
    this.showPreview(this.canvases.get(CHARACTER_LIST[0]?.id ?? 'vanguard') ?? null);
  }

  /** Per-frame hook: only the select screen ever draws, and only one card. */
  render(): void {
    if (this.select && isVisible(this.select)) this.previews.render();
  }

  private showPreview(canvas: HTMLCanvasElement | null): void {
    this.previews.setActive(canvas);
  }

  showLoading(title: string): void {
    this.hideAll();
    if (this.loading) show(this.loading, true);
    if (this.loadingTitle) this.loadingTitle.textContent = title;
    this.setLoadingStep('allocating buffers');
    if (this.loadingBar) this.loadingBar.style.width = '0%';
    if (this.loadingTip) this.loadingTip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  setLoadingStep(text: string, progress?: number): void {
    if (this.loadingStep) this.loadingStep.textContent = `${text}…`;
    if (progress !== undefined && this.loadingBar) this.loadingBar.style.width = `${Math.round(progress * 100)}%`;
  }

  showPause(summary: { label: string; value: string }[]): void {
    this.hideAll();
    if (this.pause) show(this.pause, true);
    if (this.pauseStats) {
      clear(this.pauseStats);
      for (const entry of summary) {
        const cell = make('div');
        cell.append(make('b', undefined, entry.value));
        cell.append(make('span', undefined, entry.label));
        this.pauseStats.append(cell);
      }
    }
  }

  showSettings(returnTo: 'menu' | 'pause'): void {
    this.hideAll();
    const panel = this.settings;
    if (panel) {
      show(panel, true);
      panel.dataset.returnTo = returnTo;
    }
    this.renderSettings();
  }

  showGameOver(sub: string): void {
    this.hideAll();
    if (this.gameover) show(this.gameover, true);
    if (this.gameoverSub) this.gameoverSub.textContent = sub;
  }

  showVictory(lines: { label: string; value: string }[]): void {
    this.hideAll();
    if (this.victory) show(this.victory, true);
    if (this.victoryBody) {
      clear(this.victoryBody);
      for (const line of lines) {
        const cell = make('div');
        cell.append(make('b', undefined, line.value));
        cell.append(make('span', undefined, line.label));
        this.victoryBody.append(cell);
      }
    }
  }

  showError(message: string): void {
    this.hideAll();
    if (this.error) show(this.error, true);
    if (this.errorText) this.errorText.textContent = message;
  }

  /** Short-lived corner message, used by saves and debug cheats. */
  toast(text: string, duration = 2200): void {
    if (!this.toastLayer) return;
    const node = make('div', 'toast', text);
    this.toastLayer.append(node);
    window.setTimeout(() => node.remove(), duration);
  }

  // ------------------------------------------------------------ character UI

  private buildCharacterCards(): void {
    if (!this.selectGrid) return;
    clear(this.selectGrid);
    for (const definition of CHARACTER_LIST) {
      const ability = ACTIVE_SKILLS[definition.activeSkillId];
      const card = make('div', 'char-card');
      card.dataset.character = definition.id;

      // Turntable preview of the actual operator body.
      const canvas = document.createElement('canvas');
      canvas.className = 'char-preview';
      canvas.width = PREVIEW_SIZE;
      canvas.height = PREVIEW_SIZE;
      this.canvases.set(definition.id, canvas);
      this.previews.addSlot(canvas, definition.id);
      card.append(canvas);

      card.append(make('h3', undefined, definition.name.toUpperCase()));
      card.append(make('div', 'tag', definition.tagline));

      const chips = make('div');
      for (const specialty of definition.specialties) {
        chips.append(make('span', 'char-chip', specialty));
      }
      card.append(chips);
      card.append(make('p', undefined, definition.description));

      const stats = make('div', 'char-stats');
      const meter = (label: string, ratio: number): void => {
        const cell = make('div');
        cell.append(make('span', undefined, label));
        const bar = make('div', 'stat-meter');
        const fill = make('i');
        fill.style.width = `${Math.round(Math.max(0.05, Math.min(1, ratio)) * 100)}%`;
        bar.append(fill);
        cell.append(bar);
        stats.append(cell);
      };
      meter('HEALTH', definition.stats.maxHealth / 160);
      meter('SHIELD', definition.stats.maxShield / 70);
      meter('SPEED', definition.stats.sprintSpeed / 12.5);
      meter('DAMAGE', definition.stats.weaponDamageModifier / 1.2);
      meter('CRIT', definition.stats.criticalChance / 0.14);
      card.append(stats);

      if (ability) {
        card.append(make('div', 'sub', `ACTIVE · ${ability.name}: ${ability.description}`));
      }

      card.addEventListener('click', () => {
        audio.play('ui_select');
        this.chosen = definition.id;
        for (const other of Array.from(this.selectGrid?.querySelectorAll('.char-card') ?? [])) {
          other.classList.toggle('sel', other === card);
        }
        this.showPreview(canvas);
        if (this.selectConfirm) this.selectConfirm.disabled = false;
      });

      this.selectGrid.append(card);
    }
  }

  // ---------------------------------------------------------------- settings

  private renderSettings(): void {
    if (!this.settingsBody) return;
    clear(this.settingsBody);
    const settings = this.hosts.settings.settings;

    const slider = (
      label: string,
      key: keyof SettingsState,
      min: number,
      max: number,
      step: number,
      format: (value: number) => string,
    ): void => {
      const row = make('div', 'set-row');
      const input = make('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(settings[key] as number);
      const value = make('span', 'val', format(settings[key] as number));
      input.addEventListener('input', () => {
        const next = Number(input.value);
        (settings[key] as number) = next;
        value.textContent = format(next);
        this.hosts.settings.changed(settings);
      });
      row.append(make('label', undefined, label), input, value);
      this.settingsBody?.append(row);
    };

    slider('MOUSE SENSITIVITY', 'sensitivity', 0.0006, 0.005, 0.0001, (v) => v.toFixed(4));
    slider('FIELD OF VIEW', 'fov', 65, 110, 1, (v) => `${Math.round(v)}°`);
    slider('MASTER VOLUME', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    slider('SCREEN SHAKE', 'screenShake', 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`);

    const toggle = (label: string, key: 'invertY' | 'showDamageNumbers'): void => {
      const row = make('div', 'set-row');
      row.append(make('label', undefined, label));
      const seg = make('div', 'set-seg');
      for (const option of ['ON', 'OFF']) {
        const button = make('button', undefined, option);
        const wanted = option === 'ON';
        button.classList.toggle('on', settings[key] === wanted);
        button.addEventListener('click', () => {
          (settings[key] as boolean) = wanted;
          for (const sibling of seg.querySelectorAll('button')) sibling.classList.remove('on');
          button.classList.add('on');
          this.hosts.settings.changed(settings);
        });
        seg.append(button);
      }
      row.append(seg);
      this.settingsBody?.append(row);
    };

    toggle('INVERT Y AXIS', 'invertY');
    toggle('FLOATING DAMAGE NUMBERS', 'showDamageNumbers');

    const qualityRow = make('div', 'set-row');
    qualityRow.append(make('label', undefined, 'QUALITY'));
    const seg = make('div', 'set-seg');
    for (const option of ['low', 'medium', 'high'] as const) {
      const button = make('button', undefined, option.toUpperCase());
      button.classList.toggle('on', settings.quality === option);
      button.addEventListener('click', () => {
        settings.quality = option;
        for (const sibling of seg.querySelectorAll('button')) sibling.classList.remove('on');
        button.classList.add('on');
        this.hosts.settings.changed(settings);
      });
      seg.append(button);
    }
    qualityRow.append(seg);
    this.settingsBody.append(qualityRow);

    const note = make('div', 'panel-hint');
    note.textContent = 'Settings save automatically. Quality low disables shadows and thins particles.';
    this.settingsBody.append(note);
  }

  // ----------------------------------------------------------------- buttons

  private bindButtons(): void {
    if (this.bound) return;
    this.bound = true;

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.dataset.action) return;
      const action = target.dataset.action;
      audio.play(action === 'exit' || action === 'select-back' ? 'ui_back' : 'ui_select');

      switch (action) {
        case 'new-game':
          this.hosts.menu.onNewGame();
          break;
        case 'continue':
          this.hosts.menu.onContinue();
          break;
        case 'character':
          this.hosts.menu.onCharacter();
          break;
        case 'settings':
          this.hosts.menu.onSettings();
          break;
        case 'select-confirm':
          if (this.chosen) this.hosts.select.onDeploy(this.chosen);
          break;
        case 'select-back':
          this.hosts.select.onBack();
          break;
        case 'resume':
          this.hosts.pause.onResume();
          break;
        case 'pause-settings':
          this.hosts.pause.onSettings();
          break;
        case 'save-now':
          this.hosts.pause.onSave();
          break;
        case 'main-menu':
          this.hosts.pause.onMainMenu();
          break;
        case 'settings-back':
          this.hosts.settings.onBack();
          break;
        case 'respawn':
          this.hosts.pause.onResume();
          break;
        case 'victory-keep':
          this.hosts.pause.onResume();
          break;
        case 'exit':
          this.hosts.menu.onExit();
          break;
        case 'reload':
          window.location.reload();
          break;
        default:
          break;
      }
    });
  }

  /** Formats the save summary for the main menu detail panel. */
  static summary(summary: {
    characterName: string;
    level: number;
    playtimeSeconds: number;
    questText: string;
    updatedAt: number;
  }): string {
    const date = new Date(summary.updatedAt);
    return [
      `Operator: ${summary.characterName}`,
      `Level: ${summary.level}`,
      `Playtime: ${formatTime(summary.playtimeSeconds)}`,
      `Objective: ${summary.questText}`,
      `Saved: ${date.toLocaleString()}`,
    ].join('\n');
  }
}
