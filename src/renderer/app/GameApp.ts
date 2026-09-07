import * as THREE from 'three';
import { FixedStep } from '../game/core/FixedStep';
import type { CharacterId, SettingsState, Weapon } from '../../shared/types';
import { PLAYER_HEIGHT, PLAYER_RADIUS, INVENTORY_SLOTS, STARTING_RESERVE_MULTIPLIER } from '../../shared/constants';
import { ACTIVE_SKILLS, CHARACTERS, FRAG } from '../data/characters/characters';
import { PROTOTYPE_WEAPON_NAME } from '../data/quests/quests';
import { audio } from '../game/audio/AudioSystem';
import { CombatSystem } from '../game/combat/CombatSystem';
import { bus, GameEvents } from '../game/core/EventBus';
import { GameDirector } from '../game/core/GameDirector';
import { ActionKey, input } from '../game/core/Input';
import { RNG } from '../game/core/Rng';
import { SaveManager, isDevelopment } from '../game/core/SaveManager';
import { AppState, states } from '../game/core/StateManager';
import { EffectsSystem, disposeSharedLootGeometries } from '../game/effects/EffectsSystem';
import { EnemyManager } from '../game/enemies/EnemyManager';
import { EnemyFactory } from '../game/enemies/EnemyModels';
import { LootSystem } from '../game/loot/LootSystem';
import { CollisionWorld } from '../game/physics/CollisionWorld';
import { CombatDrone, droneDamage } from '../game/player/CombatDrone';
import { PlayerController } from '../game/player/PlayerController';
import { PlayerState } from '../game/player/PlayerState';
import { WeaponController } from '../game/weapons/WeaponController';
import { generateWeapon } from '../game/weapons/WeaponGenerator';
import { QuestSystem } from '../game/quests/QuestSystem';
import { skillsFor } from '../data/skills/skills';
import { World } from '../game/world/World';
import { byId, formatTime } from '../ui/dom';
import { Hud } from '../ui/hud/Hud';
import { LootTooltip } from '../ui/hud/LootTooltip';
import { InventoryUI, type InventoryHost } from '../ui/inventory/InventoryUI';
import { DebugOverlay } from '../ui/menu/DebugOverlay';
import { ScreensUI } from '../ui/menu/ScreensUI';
import { SkillsUI } from '../ui/skills/SkillsUI';

/**
 * Game application shell. Builds the engine layer, owns the frame loop and
 * wires systems together. Gameplay rules live in the systems; this file is
 * orchestration, input routing and save/load glue only.
 */

const SAVE_FILE = 'save_slot_1.json';

interface AbilityState {
  id: string;
  remaining: number;
  cooldown: number;
  cooldownTotal: number;
}

export class GameApp {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private lights: THREE.DirectionalLight;

  private collision = new CollisionWorld();
  private effects: EffectsSystem;
  private enemies: EnemyManager;
  private combat: CombatSystem;
  private loot: LootSystem;
  private world: World;
  private director: GameDirector;
  private quest = new QuestSystem();

  private player = new PlayerState();
  private controller: PlayerController;
  private weapons: WeaponController;
  private drone: CombatDrone;

  private hud: Hud;
  private lootTooltip: LootTooltip;
  private screens: ScreensUI;
  private skillsUI: SkillsUI;
  private inventoryUI: InventoryUI;
  private debug = new DebugOverlay();
  private saves = new SaveManager(SAVE_FILE);

  private backpack: Weapon[] = [];
  private salvage = 0;
  private runStats = { enemiesKilled: 0, bossesKilled: 0, weaponsFound: 0, shotsFired: 0, shotsHit: 0 };

  private settings: SettingsState = {
    sensitivity: 0.0022,
    invertY: false,
    fov: 78,
    masterVolume: 0.7,
    showDamageNumbers: true,
    screenShake: 1,
    quality: 'high',
  };

  private abilityF: AbilityState = { id: 'overdrive', remaining: 0, cooldown: 0, cooldownTotal: 26 };
  private abilityQ: AbilityState = { id: 'frag_burst', remaining: 0, cooldown: 0, cooldownTotal: 16 };

  private clock = new THREE.Clock();
  private elapsed = 0;
  private playtime = 0;
  private lastZone = '';
  private prototypeDropped = false;
  private saving = false;
  private pendingSave = false;
  private running = false;
  private handle = 0;
  private resizeHandler: () => void;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor() {
    const viewport = byId('viewport') ?? document.body;
    const overlay = byId('world-overlay') ?? document.body;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0xc99a63);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.05, 900);
    this.scene.add(this.camera);
    this.lights = this.buildLights();

    this.effects = new EffectsSystem(this.scene, overlay);
    this.effects.setCamera(this.camera);

    this.world = new World(this.scene, this.collision, new RNG(0x5eed));
    this.enemies = new EnemyManager(this.scene, this.collision, this.effects, overlay, this.camera);
    this.combat = new CombatSystem(this.scene, this.collision, this.effects, this.enemies.targets);
    this.loot = new LootSystem(this.scene, (x, z) => this.groundY(x, z));
    this.director = new GameDirector(this.enemies, this.loot);

    this.controller = new PlayerController(this.collision, this.player, this.camera);
    this.weapons = new WeaponController(this.camera, this.scene, this.combat, this.effects, this.player, this.controller);
    this.drone = new CombatDrone(this.scene);

    this.hud = new Hud(this.player, this.weapons);
    this.lootTooltip = new LootTooltip();

    this.screens = new ScreensUI({
      menu: {
        onNewGame: () => this.enterCharacterSelect(),
        onContinue: () => void this.continueRun(),
        onCharacter: () => this.enterCharacterSelect(),
        onSettings: () => this.screens.showSettings('menu'),
        onExit: () => void this.exitGame(),
        hasSave: false,
        saveSummary: '',
      },
      select: {
        onDeploy: (characterId) => void this.startNewGame(characterId),
        onBack: () => this.gotoMain(),
      },
      pause: {
        onResume: () => this.resume(),
        onSettings: () => this.screens.showSettings('pause'),
        onSave: () => void this.performSave('manual'),
        onMainMenu: () => void this.returnToMenu(),
        onExit: () => void this.exitGame(),
      },
      settings: {
        settings: this.settings,
        changed: (next) => this.applySettings(next),
        onBack: () => this.leaveSettings(),
      },
    });

    this.skillsUI = new SkillsUI(this.player, {
      spendSkillPoint: (skillId) => this.spendSkillPoint(skillId),
    });

    this.inventoryUI = new InventoryUI(this.player, this.weapons, this.inventoryHost());

    this.bindBus();
    this.bindHotkeys();
    this.bindWindow();

    this.resizeHandler = () => this.onResize();
  }

  // ------------------------------------------------------------------ boot

  async boot(): Promise<void> {
    this.settings = await this.saves.loadSettings();
    this.applySettings(this.settings, true);
    await this.saves.refreshList();
    this.refreshMenuSaveInfo();
    this.screens.showMenu();
    states.reset();
    this.startLoop();
  }

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = (): void => {
      this.handle = requestAnimationFrame(tick);
      this.frame();
    };
    this.handle = requestAnimationFrame(tick);
  }

  private simulation = new FixedStep();

  private frame(): void {
    // Clamp dt so an alt-tab or a slow frame cannot tunnel the player through
    // geometry or make enemies skip their whole attack tick.
    const dt = Math.min(0.25, this.clock.getDelta());

    if (states.isPlaying()) {
      this.simulation.advance(dt, (step) => {
        if (!states.isPlaying()) return;
        this.elapsed += step;
        this.playtime += step;
        this.simulate(step);
        input.endFrame();
      });
    } else {
      this.simulation.reset();
      input.endFrame();
      // Menus still need the world to animate (and the camera to hold still).
      this.world.update(dt);
      this.effects.update(dt);
    }

    this.renderer.render(this.scene, this.camera);
    if (this.debug.isOpen) this.reportDebug();
  }

  // -------------------------------------------------------------- simulate

  private simulate(dt: number): void {
    const frozen = this.player.dead;

    // Look first so aim is current before any shot is resolved.
    const look = this.controller.consumeLook();
    if (!frozen) {
      this.controller.look(look.dx, look.dy, this.settings.sensitivity, this.settings.invertY);
    }

    if (!frozen) this.controller.update(dt);
    this.controller.updateCamera(dt);

    this.player.update(dt);
    this.world.update(dt);

    const fireContext = {
      damageMultiplier: this.player.buff.damage,
      fireRateMultiplier: this.player.buff.fireRate,
      spreadMultiplier: this.player.buff.spread,
      criticalChance: this.player.effectiveCriticalChance,
      criticalMultiplier: this.player.effectiveCriticalDamage,
      reloadTimeMultiplier: this.player.stats.reloadTimeMult,
    };

    this.weapons.update(dt, fireContext, {
      fireHeld: input.firing && !frozen,
      firePressed: input.firePressed && !frozen,
      aiming: input.aiming && !frozen,
    });
    this.hud.setAiming(this.weapons.isAiming);

    this.enemies.update(dt, {
      damagePlayer: (amount) => this.damagePlayer(amount),
      shoot: (origin, dir, damage, speed) => {
        this.combat.fireProjectile({
          origin,
          direction: dir,
          speed,
          damage,
          fromPlayer: false,
          gravity: speed > 40 ? 0 : 3.2,
          radius: speed > 40 ? 0.14 : 0.26,
          life: 5,
        });
      },
      explode: (point, radius, damage) => {
        this.effects.explosion(point, radius);
        const chest = this.controller.position.clone().add(new THREE.Vector3(0, 1, 0));
        const distance = chest.distanceTo(point);
        if (distance < radius && this.collision.hasLineOfSight(point, chest)) {
          this.damagePlayer(damage * (1 - 0.55 * distance / radius), point);
          const push = chest.sub(point).normalize().multiplyScalar(8 * (1 - distance / radius));
          this.controller.addImpulse(push.x, Math.max(2, push.y), push.z);
        }
      },
      groundY: (x, z) => this.groundY(x, z),
      playerPosition: this.controller.position,
      playerAlive: !this.player.dead,
    }, this.elapsed);

    this.combat.update(dt, (amount, point) => this.damagePlayer(amount, point), {
      position: this.controller.position, height: this.controller.crouching ? PLAYER_HEIGHT * 0.62 : PLAYER_HEIGHT, radius: PLAYER_RADIUS, alive: !frozen,
    });
    this.effects.update(dt);
    this.updateDrone(dt);
    this.updateAbilities(dt);

    this.director.update({
      playerPosition: this.controller.position,
      playerLevel: this.player.level,
      isStepComplete: (stepId) => this.quest.isStepComplete(stepId),
      isCurrentStep: (stepId) => this.quest.isCurrentStep(stepId),
    });

    this.quest.update({ playerPosition: this.controller.position });
    this.checkZoneEntry();

    const focus = this.loot.update(dt, this.controller.position, this.weapons.slots);
    this.hud.setInteraction(focus);

    if (input.wasPressed(ActionKey.Reload)) this.weapons.tryReload();
    if (input.wasPressed(ActionKey.Interact)) this.interact();
    if (input.wasPressed(ActionKey.SkillF)) this.useAbility('F');
    if (input.wasPressed(ActionKey.SkillQ)) this.useAbility('Q');
    if (input.wasPressed(ActionKey.Slot1)) this.weapons.selectSlot(0);
    if (input.wasPressed(ActionKey.Slot2)) this.weapons.selectSlot(1);
    if (input.wasPressed(ActionKey.Slot3)) this.weapons.selectSlot(2);
    if (input.wheelDelta !== 0) this.cycleSlot(input.wheelDelta);

    this.updateBossBar();
    this.hud.update(dt, {
      f: this.abilityF.cooldown,
      fTotal: this.abilityF.cooldownTotal,
      q: this.abilityQ.cooldown,
      qTotal: this.abilityQ.cooldownTotal,
      fActive: this.abilityF.remaining > 0,
    });

    if (this.player.dead) this.onPlayerDeath();
  }

  private cycleSlot(direction: number): void {
    const filled = this.weapons.slots
      .map((weapon, index) => (weapon ? index : -1))
      .filter((index) => index >= 0);
    if (filled.length === 0) return;
    const current = filled.indexOf(this.weapons.activeSlot);
    const next = filled[(current + (direction > 0 ? 1 : filled.length - 1) + filled.length) % filled.length] ?? 0;
    this.weapons.selectSlot(next);
  }

  private updateDrone(dt: number): void {
    if (!this.drone.active) return;
    const target = this.enemies.nearestAlive(this.controller.position, 45);
    this.drone.setTarget(target ? target.position.clone().add(new THREE.Vector3(0, 1, 0)) : null);
    this.drone.update(dt, {
      playerPosition: this.controller.position,
      shoot: (origin, dir) => {
        const results = this.combat.fireHitscan({
          origin,
          direction: dir,
          weapon: this.weapons.current ?? generateWeapon({ type: 'pistol', rarity: 'common' }),
          damage: droneDamage(16 + this.player.level * 2.5),
          criticalChance: 0.05,
          criticalMultiplier: 1.6,
          spread: 0.02,
          shieldBonus: 0,
          source: 'player',
        });
        const hit = results.some((entry) => entry.target);
        if (hit) {
          const first = results.find((entry) => entry.target);
          if (first) this.effects.tracer(origin, first.point, 0x8ef0ff, 1);
        }
        audio.playAt('weapon_shot_smg', origin.distanceTo(this.controller.position), 60, 60);
        return hit;
      },
      onTargetLost: () => this.drone.setTarget(null),
    });
  }

  private updateBossBar(): void {
    const boss = this.enemies.boss;
    if (!boss) {
      this.hud.setBoss('', 0, 0, false);
      return;
    }
    this.hud.setBoss(
      boss.definition.name,
      boss.health / Math.max(1, boss.maxHealth),
      boss.maxShield > 0 ? boss.shield / boss.maxShield : 0,
      true,
    );
  }

  private checkZoneEntry(): void {
    const zone = this.world.zoneAt(this.controller.position.x, this.controller.position.z);
    const id = zone?.id ?? '';
    if (id === this.lastZone) return;
    this.lastZone = id;
    this.controller.inSafeZone = zone?.safe ?? false;
    if (!zone) return;
    bus.emit(GameEvents.ZoneEntered, { id: zone.id, name: zone.name });
    if (!zone.safe) this.hud.notify(zone.name.toUpperCase(), { sub: 'ENTERING', duration: 2.2 });
    this.quest.notifyZoneEntered(zone.id);
  }

  // ---------------------------------------------------------------- damage

  private damagePlayer(amount: number, point?: THREE.Vector3): void {
    if (this.player.dead) return;
    const killed = this.player.applyDamage(amount);
    const at = point ?? this.controller.position;
    this.effects.damageNumber(this.tmpA.copy(at).setY(this.controller.position.y + 1.9), `-${Math.round(amount)}`, 'player');
    this.controller.addShake(Math.min(0.7, amount / 90) * this.settings.screenShake);
    audio.playAt('player_hurt', at.distanceTo(this.controller.position), 40, 120);
    if (killed) this.onPlayerDeath();
  }

  private onPlayerDeath(): void {
    if (states.state === AppState.GameOver) return;
    this.player.dead = true;
    audio.play('enemy_death', 0.6);
    input.exitPointerLock();
    states.set(AppState.GameOver);
    this.screens.showGameOver(this.deathFlavour());
  }

  private deathFlavour(): string {
    const lines = [
      'The outpost keeps its salvage.',
      'Scrap is patient. So is the desert.',
      'Another operator on the missing list.',
      'The Titan will not even notice you were here.',
    ];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  private respawn(): void {
    this.player.revive();
    this.weapons.topUpAmmo(1);
    const anchor = RESPAWN_ANCHOR(this.world);
    this.controller.teleport(anchor.x, anchor.y, anchor.z, this.controller.yaw);
    this.enemies.clear();
    this.loot.clear();
    this.drone.recall();
    this.director.reset();
    this.prototypeDropped = false;
    this.lastZone = '';
    this.hud.notify('RESPAWNED AT CAMP', { sub: 'EXTRACTION BEACON', duration: 3 });
    states.set(AppState.Playing);
    input.requestPointerLock();
  }

  // -------------------------------------------------------------- abilities

  private configureAbilities(): void {
    const definition = CHARACTERS[this.player.characterId] ?? CHARACTERS.vanguard;
    const primary = ACTIVE_SKILLS[definition.activeSkillId];
    const secondary = ACTIVE_SKILLS.frag_burst;
    const cooldownMult = this.player.stats.cooldownMult;
    this.abilityF = {
      id: primary.id,
      remaining: 0,
      cooldown: 0,
      cooldownTotal: Math.max(4, primary.cooldown * cooldownMult),
    };
    this.abilityQ = {
      id: secondary.id,
      remaining: 0,
      cooldown: 0,
      cooldownTotal: Math.max(4, secondary.cooldown * cooldownMult),
    };
    this.hud.setAbilityNames(primary.name, secondary.name);
  }

  private updateAbilities(dt: number): void {
    this.tickAbility(this.abilityF, dt, () => this.resetBuffs());
    this.tickAbility(this.abilityQ, dt);
  }

  private tickAbility(ability: AbilityState, dt: number, onExpire?: () => void): void {
    if (ability.remaining > 0) {
      ability.remaining -= dt;
      if (ability.remaining <= 0) {
        ability.remaining = 0;
        onExpire?.();
      }
    }
    if (ability.cooldown > 0) ability.cooldown = Math.max(0, ability.cooldown - dt);
  }

  private resetBuffs(): void {
    this.player.buff.fireRate = 1;
    this.player.buff.damage = 1;
    this.player.buff.moveSpeed = 1;
    this.player.buff.criticalChance = 0;
    this.player.buff.criticalDamage = 1;
    this.player.buff.spread = 1;
  }

  private useAbility(slot: 'F' | 'Q'): void {
    if (this.player.dead) return;
    const ability = slot === 'F' ? this.abilityF : this.abilityQ;
    if (ability.cooldown > 0 || ability.remaining > 0) {
      audio.play('ui_back', 0.4);
      return;
    }
    const definition = ACTIVE_SKILLS[ability.id];
    if (!definition) return;

    audio.play('ability_used');
    bus.emit(GameEvents.ActiveSkillUsed, { id: ability.id, name: definition.name, slot });
    ability.cooldownTotal = Math.max(4, definition.cooldown * this.player.stats.cooldownMult);
    ability.cooldown = ability.cooldownTotal;

    switch (ability.id) {
      case 'overdrive':
        ability.remaining = definition.duration;
        this.player.buff.moveSpeed = 1.35;
        this.player.buff.fireRate = 1.4;
        this.player.buff.damage = 1.3;
        this.hud.notify('OVERDRIVE', { sub: `${definition.duration}s`, duration: definition.duration });
        break;
      case 'focus':
        ability.remaining = definition.duration;
        this.player.buff.criticalChance = 0.3;
        this.player.buff.criticalDamage = 1.6;
        this.player.buff.spread = 0.35;
        this.hud.notify('FOCUS', { sub: `${definition.duration}s`, duration: definition.duration });
        break;
      case 'combat_drone':
        ability.remaining = 0.2;
        this.drone.deploy(definition.duration, 16 + this.player.level * 2.5);
        this.hud.notify('DRONE DEPLOYED', { sub: `${definition.duration}s`, duration: definition.duration });
        break;
      case 'frag_burst':
        this.throwFrag();
        break;
      default:
        break;
    }
  }

  private throwFrag(): void {
    const origin = this.weapons.muzzleWorld(this.tmpA.clone());
    const direction = this.controller.aimDirection(this.tmpB.clone());
    this.combat.fireExplosive({
      origin,
      direction,
      speed: FRAG.projectileSpeed,
      fuse: FRAG.fuse,
      damage: FRAG.damage + this.player.level * 8,
      radius: FRAG.radius,
      shieldBonus: FRAG.shieldBonus,
    });
    this.controller.addShake(0.25 * this.settings.screenShake);
  }

  // ------------------------------------------------------------- interaction

  private interact(): void {
    const item = this.loot.focusTarget;
    if (!item) return;

    if (item.kind === 'weapon' && item.weapon) {
      const weapon = item.weapon;
      if (item.questItem) {
        this.loot.remove(item);
        this.quest.notifyCollect(item.targetId ?? 'prototype');
        this.runStats.weaponsFound += 1;
        this.hud.notify(PROTOTYPE_WEAPON_NAME, { tone: 'legendary', sub: 'SALVAGE SECURED', duration: 4 });
        this.screens.showVictory(this.victoryLines());
        states.set(AppState.Victory);
        input.exitPointerLock();
        void this.performSave('quest');
        return;
      }

      const replaced = this.weapons.equip(weapon);
      this.runStats.weaponsFound += 1;
      this.loot.pickup(item);
      if (replaced) {
        if (!this.addToBackpack(replaced)) {
          this.loot.dropWeapon(replaced, this.controller.position.clone());
          this.hud.notify('BACKPACK FULL', { tone: 'warn', sub: 'DROPPED OLD WEAPON', duration: 2.6 });
        }
      }
      bus.emit(GameEvents.InventoryChanged, {});
      SaveManager.requestAutosave('loot');
      return;
    }

    if (item.kind === 'health') {
      const amount = LootSystem.pickupValue('health', item.amount);
      this.player.heal(amount);
      this.effects.damageNumber(this.controller.eyePosition, `+${amount}`, 'normal');
      this.loot.pickup(item);
      return;
    }
    if (item.kind === 'shield') {
      const amount = LootSystem.pickupValue('shield', item.amount);
      this.player.shield = Math.min(this.player.stats.maxShield, this.player.shield + amount);
      this.player.timeSinceDamage = 0;
      this.effects.damageNumber(this.controller.eyePosition, `+${amount} SHIELD`, 'shield');
      this.loot.pickup(item);
      return;
    }
    this.salvage += item.amount;
    this.loot.pickup(item);
    this.hud.notify(`+${item.amount} SALVAGE`, { duration: 1.6 });
  }

  private addToBackpack(weapon: Weapon): boolean {
    if (this.backpack.length >= INVENTORY_SLOTS) return false;
    this.backpack.push(weapon);
    return true;
  }

  // ------------------------------------------------------------- save / load

  private payload() {
    return {
      fileName: SAVE_FILE,
      character: {
        characterId: this.player.characterId,
        name: (CHARACTERS[this.player.characterId] ?? CHARACTERS.vanguard).name,
        level: this.player.level,
        xp: this.player.xp,
        health: this.player.health,
        shield: this.player.shield,
        skillPoints: this.player.skillPoints,
      },
      progression: { skills: { ...this.player.skillRanks } },
      inventory: this.backpack,
      equipped: this.weapons.slots.map((slot) => slot),
      quests: this.quest.quests,
      stats: { ...this.runStats, shotsFired: this.combat.stats.shotsFired, shotsHit: this.combat.stats.shotsHit },
      settings: this.settings,
      playerPosition: {
        x: this.controller.position.x,
        y: this.controller.position.y,
        z: this.controller.position.z,
      },
      playerYaw: this.controller.yaw,
      clearedGroups: this.director.clearedGroupIds,
      playtimeSeconds: this.playtime,
      questText: this.quest.objectiveText,
    };
  }

  private async performSave(reason: string): Promise<void> {
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    const ok = await this.saves.save(this.payload());
    this.saving = false;
    this.screens.toast(ok ? `PROGRESS SAVED (${reason})` : 'SAVE FAILED', 1800);
    this.refreshMenuSaveInfo();
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.performSave('queued');
    }
  }

  private refreshMenuSaveInfo(): void {
    const latest = this.saves.latest;
    const screens = this.screens as unknown as { hosts?: { menu: { hasSave: boolean; saveSummary: string } } };
    const summary = latest
      ? ScreensUI.summary({
          characterName: latest.characterName,
          level: latest.level,
          playtimeSeconds: latest.playtimeSeconds,
          questText: latest.questText,
          updatedAt: latest.updatedAt,
        })
      : '';
    // The host object literal is captured by reference in the constructor.
    (screens as unknown as { hosts: { menu: { hasSave: boolean; saveSummary: string } } }).hosts.menu.hasSave = this.saves.hasSave;
    (screens as unknown as { hosts: { menu: { hasSave: boolean; saveSummary: string } } }).hosts.menu.saveSummary = summary;
  }

  private async returnToMenu(): Promise<void> {
    if (states.isPlaying() || states.state === AppState.Paused || states.state === AppState.GameOver) {
      await this.performSave('menu');
    }
    this.teardownRun();
    input.exitPointerLock();
    states.set(AppState.MainMenu);
    this.screens.showMenu();
  }

  private async exitGame(): Promise<void> {
    if (states.isPlaying() || states.state === AppState.Paused) {
      await this.performSave('exit');
    }
    await this.saves.quit();
  }

  // ------------------------------------------------------------ run control

  private enterCharacterSelect(): void {
    states.set(AppState.CharacterSelect);
    this.screens.showSelect();
    input.exitPointerLock();
  }

  private gotoMain(): void {
    states.set(AppState.MainMenu);
    this.screens.showMenu();
  }

  private async startNewGame(characterId: CharacterId): Promise<void> {
    await this.beginRun(async () => {
      this.player.configure(characterId, 1, {});
      this.player.skillPoints = 1;
      this.quest.reset();
      const definition = CHARACTERS[characterId] ?? CHARACTERS.vanguard;
      const starter = generateWeapon({ type: definition.startingWeapon, level: 1, rarity: 'common' });
      starter.reserveAmmo = Math.round(starter.magazineSize * STARTING_RESERVE_MULTIPLIER * this.player.stats.ammoReserveMult);
      this.weapons.setSlots([starter, null, null], 0);
      this.backpack = [];
      this.salvage = 0;
      this.runStats = { enemiesKilled: 0, bossesKilled: 0, weaponsFound: 0, shotsFired: 0, shotsHit: 0 };
      this.playtime = 0;
      this.prototypeDropped = false;
      const spawn = this.world.anchors.playerSpawn;
      this.controller.teleport(spawn.x, spawn.y, spawn.z, -Math.PI / 4);
    }, 'DEPLOYING');
  }

  private async continueRun(): Promise<void> {
    const data = await this.saves.load();
    if (!data) {
      this.screens.toast('NO SAVE FOUND', 1800);
      return;
    }
    await this.beginRun(async () => {
      this.player.configure(data.character.characterId, data.character.level, data.progression.skills);
      this.player.skillPoints = data.character.skillPoints;
      this.player.xp = data.character.xp;
      this.player.health = Math.max(20, data.character.health);
      this.player.shield = data.character.shield;
      this.backpack = data.inventory;
      this.weapons.setSlots(data.equipped, 0);
      this.quest.load(data.quests);
      this.runStats = {
        enemiesKilled: data.stats.enemiesKilled,
        bossesKilled: data.stats.bossesKilled,
        weaponsFound: data.stats.weaponsFound,
        shotsFired: data.stats.shotsHit ? data.stats.shotsFired : 0,
        shotsHit: data.stats.shotsHit,
      };
      this.settings = { ...this.settings, ...data.settings };
      this.applySettings(this.settings, true);
      this.playtime = data.playtimeSeconds;
      this.prototypeDropped = this.quest.isStepComplete('collect_prototype');
      this.director.markCleared(data.clearedGroups ?? []);
      const position = data.playerPosition ?? this.world.anchors.playerSpawn;
      this.controller.teleport(position.x, position.y, position.z, data.playerYaw ?? 0);
      this.hud.notify('WELCOME BACK', { sub: `LEVEL ${this.player.level}`, duration: 3 });
    }, 'RESTORING');
  }

  /**
   * Shared boot path for a fresh run and a loaded save: build the world once,
   * run the per-run setup, then hand control to the player.
   */
  private async beginRun(setup: () => Promise<void> | void, title: string): Promise<void> {
    states.set(AppState.Loading);
    this.screens.showLoading(title);
    this.teardownRun();

    await this.yieldFrame();
    this.screens.setLoadingStep('generating terrain', 0.18);

    // The world is built once at construction and reused; only the dynamic
    // content is reset, which keeps reloads instant.
    await this.yieldFrame();
    this.screens.setLoadingStep('spawning hostiles', 0.42);
    this.enemies.clear();
    this.loot.clear();
    this.combat.clearProjectiles();
    this.director.reset();
    this.drone.recall();

    await this.yieldFrame();
    this.screens.setLoadingStep('loading operator', 0.68);
    await setup();
    this.configureAbilities();
    this.lastZone = '';

    await this.yieldFrame();
    this.screens.setLoadingStep('ready', 1);
    await this.yieldFrame();

    states.set(AppState.Playing);
    this.hud.setCharacterName((CHARACTERS[this.player.characterId] ?? CHARACTERS.vanguard).name.toUpperCase());
    this.hud.setObjective(this.quest.objectiveText, this.quest.progressText);
    this.hud.setVisible(true);
    input.attach(this.renderer.domElement);
    input.requestPointerLock();
    audio.unlock();
  }

  private teardownRun(): void {
    this.enemies.clear();
    this.loot.clear();
    this.combat.clearProjectiles();
    this.drone.recall();
    this.hud.setVisible(false);
    this.inventoryUI.setVisible(false);
    this.skillsUI.setVisible(false);
    this.prototypeDropped = false;
  }

  private yieldFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // ------------------------------------------------------------------ state

  private resume(): void {
    if (this.player.dead) {
      this.respawn();
      return;
    }
    states.set(AppState.Playing);
    input.requestPointerLock();
  }

  private leaveSettings(): void {
    const returnTo = this.screens.settings?.dataset.returnTo === 'pause' ? AppState.Paused : AppState.MainMenu;
    if (returnTo === AppState.Paused) {
      this.openPause();
      return;
    }
    states.set(AppState.MainMenu);
    this.screens.showMenu();
  }

  private openPause(): void {
    if (!states.set(AppState.Paused)) {
      if (states.state !== AppState.Paused) return;
    }
    input.exitPointerLock();
    this.inventoryUI.setVisible(false);
    this.skillsUI.setVisible(false);
    this.screens.showPause(this.pauseSummary());
  }

  private pauseSummary(): { label: string; value: string }[] {
    const accuracy = this.combat.stats.shotsFired > 0 ? this.combat.stats.shotsHit / this.combat.stats.shotsFired : 0;
    return [
      { label: 'LEVEL', value: String(this.player.level) },
      { label: 'XP', value: `${this.player.xp}/${this.player.xpNeeded || 'MAX'}` },
      { label: 'KILLS', value: String(this.runStats.enemiesKilled) },
      { label: 'ACCURACY', value: `${Math.round(accuracy * 100)}%` },
      { label: 'SALVAGE', value: String(this.salvage) },
      { label: 'PLAYTIME', value: formatTime(this.playtime) },
    ];
  }

  private toggleInventory(): void {
    if (states.state === AppState.Inventory) {
      states.set(AppState.Playing);
      this.inventoryUI.setVisible(false);
      input.requestPointerLock();
      return;
    }
    if (!states.isPlaying() && states.state !== AppState.Paused) return;
    states.set(AppState.Inventory);
    input.exitPointerLock();
    this.skillsUI.setVisible(false);
    this.inventoryUI.setVisible(true);
    this.inventoryUI.render(true);
  }

  private toggleSkills(): void {
    if (states.state === AppState.Skills) {
      states.set(AppState.Playing);
      this.skillsUI.setVisible(false);
      input.requestPointerLock();
      return;
    }
    if (!states.isPlaying() && states.state !== AppState.Paused) return;
    states.set(AppState.Skills);
    input.exitPointerLock();
    this.inventoryUI.setVisible(false);
    this.skillsUI.setVisible(true);
  }

  // ------------------------------------------------------------------ skills

  private spendSkillPoint(skillId: string): boolean {
    if (this.player.skillPoints <= 0) {
      this.screens.toast('NO SKILL POINTS', 1200);
      return false;
    }
    const skills = this.playerSkills();
    const skill = skills.find((entry) => entry.id === skillId);
    if (!skill) return false;
    const rank = this.player.skillRanks[skillId] ?? 0;
    if (rank >= skill.maxRanks) return false;
    if (skill.requires && (this.player.skillRanks[skill.requires] ?? 0) <= 0) {
      this.screens.toast('REQUIRES PREVIOUS TIER', 1400);
      return false;
    }
    this.player.skillRanks[skillId] = rank + 1;
    this.player.skillPoints -= 1;
    this.player.recomputeStats();
    this.configureAbilities();
    audio.play('level_up', 0.5);
    bus.emit(GameEvents.SkillUnlocked, { id: skillId, rank: rank + 1 });
    return true;
  }

  private playerSkills(): ReturnType<typeof skillsFor> {
    return skillsFor(this.player.characterId);
  }

  // ------------------------------------------------------------------- input

  private bindHotkeys(): void {
    input.attach(this.renderer.domElement);

    input.registerHotkey(ActionKey.Pause, () => {
      if (states.state === AppState.Paused) {
        this.resume();
        return;
      }
      if (states.state === AppState.Inventory || states.state === AppState.Skills) {
        this.inventoryUI.setVisible(false);
        this.skillsUI.setVisible(false);
        states.set(AppState.Playing);
        input.requestPointerLock();
        return;
      }
      if (states.isPlaying()) this.openPause();
    });

    input.registerHotkey(ActionKey.Inventory, () => this.toggleInventory());
    input.registerHotkey(ActionKey.Skills, () => this.toggleSkills());
    input.registerHotkey(ActionKey.Debug, () => this.debug.toggle());

    // Inventory shortcuts while the panel is open.
    input.registerHotkey('KeyE', () => {
      if (this.inventoryUI.isOpen) this.inventoryUI.handleKey('equip');
    });
    input.registerHotkey('KeyX', () => {
      if (this.inventoryUI.isOpen) this.inventoryUI.handleKey('drop');
    });
    input.registerHotkey('Delete', () => {
      if (this.inventoryUI.isOpen) this.inventoryUI.handleKey('destroy');
    });

    const dev = isDevelopment();
    if (dev) {
      input.registerHotkey('F5', () => this.cheatSpawnEnemy());
      input.registerHotkey('F6', () => this.cheatSpawnLoot());
      input.registerHotkey('F7', () => this.cheatXp());
      input.registerHotkey('F8', () => this.cheatHeal());
      input.registerHotkey('F9', () => this.cheatLegendary());
    }

    // Re-acquire pointer lock when the player clicks back into the world.
    this.renderer.domElement.addEventListener('mousedown', (event) => {
      if (!states.isPlaying()) return;
      if (!input.pointerLocked && event.button === 0) {
        input.requestPointerLock();
        audio.unlock();
      }
    });

    bus.on('input:pointerlock', (locked: boolean) => {
      if (locked) return;
      // Losing lock outside a menu means the OS took it; pause to be safe.
      if (states.isPlaying() && !this.player.dead) this.openPause();
    }, this);
  }

  private cheatSpawnEnemy(): void {
    if (!states.isPlaying()) return;
    const forward = this.controller.forwardVector(this.tmpA.clone()).multiplyScalar(12);
    const point = this.controller.position.clone().add(forward);
    const enemy = this.enemies.spawnRandomAt(point, this.player.level);
    this.screens.toast(enemy ? `SPAWNED ${enemy.definition.name}` : 'SPAWN BLOCKED', 1400);
  }

  private cheatSpawnLoot(): void {
    if (!states.isPlaying()) return;
    const forward = this.controller.forwardVector(this.tmpA.clone()).multiplyScalar(3);
    const weapon = this.director.spawnChest(this.controller.position.clone().add(forward), this.player.level, 'rare');
    this.screens.toast(`DROPPED ${weapon.name}`, 1600);
  }

  private cheatXp(): void {
    if (!states.isPlaying()) return;
    this.player.addXp(Math.max(50, this.player.xpNeeded));
    this.screens.toast('+XP', 1200);
  }

  private cheatHeal(): void {
    if (!states.isPlaying()) return;
    this.player.revive();
    this.weapons.topUpAmmo(1);
    this.screens.toast('VITALS RESTORED', 1200);
  }

  private cheatLegendary(): void {
    if (!states.isPlaying()) return;
    const forward = this.controller.forwardVector(this.tmpA.clone()).multiplyScalar(3);
    const weapon = this.director.spawnChest(this.controller.position.clone().add(forward), this.player.level, 'legendary');
    this.screens.toast(`${weapon.name} [LEGENDARY]`, 1800);
  }

  // ------------------------------------------------------------------ events

  private bindBus(): void {
    bus.on(GameEvents.EnemyKilled, (payload: {
      definitionId: string;
      byPlayer: boolean;
      isBoss: boolean;
      isElite: boolean;
      xpReward: number;
      position: THREE.Vector3;
      lootChance: number;
      bossMinion?: boolean;
    }) => {
      if (payload.byPlayer) {
        this.runStats.enemiesKilled += 1;
        if (payload.isBoss) this.runStats.bossesKilled += 1;
        this.player.addXp(payload.xpReward);
        this.quest.notifyKill(payload.definitionId, Boolean(payload.bossMinion));
      }
      if (payload.byPlayer || payload.isBoss) {
        this.director.rollDrop({
          definitionId: payload.definitionId,
          position: payload.position,
          isBoss: payload.isBoss,
          isElite: payload.isElite,
          lootChance: payload.lootChance,
          playerLevel: this.player.level,
          bossMinion: payload.bossMinion,
        });
      }
      if (payload.isBoss) {
        bus.emit(GameEvents.BossKilled, { definitionId: payload.definitionId });
        SaveManager.requestAutosave('boss');
      }
    }, this);

    bus.on(GameEvents.PlayerLevelUp, (payload: { level: number }) => {
      this.hud.notify(`LEVEL ${payload.level}`, { sub: '+1 SKILL POINT', duration: 3 });
      this.configureAbilities();
      SaveManager.requestAutosave('levelup');
    }, this);

    bus.on(GameEvents.Autosave, (payload: { reason: string }) => {
      if (states.isPlaying() || states.state === AppState.Victory) void this.performSave(payload.reason);
    }, this);

    bus.on(GameEvents.QuestUpdated, (payload: { objective: string; progress: string }) => {
      this.hud.setObjective(payload.objective, payload.progress);
    }, this);

    bus.on(GameEvents.ObjectiveReached, (payload: { stepId?: string }) => {
      if (payload.stepId === 'kill_boss') this.spawnPrototype();
    }, this);

    bus.on(GameEvents.BossPhase, (payload: { phase: number }) => {
      audio.play('boss_phase');
      this.controller.addShake(0.9 * this.settings.screenShake);
      void payload;
    }, this);

    bus.on(GameEvents.BossSummon, (payload: { definitionId?: string; count?: number }) => {
      const boss = this.enemies.boss;
      const anchor = boss ? boss.position : this.controller.position;
      const count = payload.count ?? 2;
      const requests = [];
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        requests.push({
          definitionId: payload.definitionId ?? (i % 2 === 0 ? 'raider' : 'rusher'),
          x: anchor.x + Math.cos(angle) * 7,
          z: anchor.z + Math.sin(angle) * 7,
          bossMinion: true,
        });
      }
      const spawned = this.enemies.spawnGroup(requests, this.player.level);
      for (const enemy of spawned) enemy.forceAggro();
      this.hud.notify('TITAN REINFORCEMENTS', { tone: 'warn', duration: 2.6 });
    }, this);

    bus.on(GameEvents.WeaponFired, () => {
      this.runStats.shotsFired = this.combat.stats.shotsFired;
    }, this);

    bus.on(GameEvents.WeaponEmpty, (payload: { reason: string }) => {
      if (payload.reason === 'empty_slot') audio.play('ui_back', 0.35);
    }, this);
  }

  private spawnPrototype(): void {
    if (this.prototypeDropped) return;
    this.prototypeDropped = true;
    const pedestal = this.world.anchors.pedestal;
    const weapon = generateWeapon({ level: this.player.level + 2, rarity: 'legendary', luck: 0.9 });
    weapon.name = PROTOTYPE_WEAPON_NAME;
    this.loot.dropWeapon(weapon, new THREE.Vector3(pedestal.x, pedestal.y, pedestal.z), {
      questItem: true,
      targetId: 'prototype',
    });
    this.hud.notify('PROTOTYPE DETECTED', { tone: 'legendary', sub: 'COLLECT IT', duration: 4.5 });
  }

  private victoryLines(): { label: string; value: string }[] {
    const accuracy = this.combat.stats.shotsFired > 0 ? this.combat.stats.shotsHit / this.combat.stats.shotsFired : 0;
    return [
      { label: 'LEVEL', value: String(this.player.level) },
      { label: 'KILLS', value: String(this.runStats.enemiesKilled) },
      { label: 'ACCURACY', value: `${Math.round(accuracy * 100)}%` },
      { label: 'PLAYTIME', value: formatTime(this.playtime) },
    ];
  }

  // ---------------------------------------------------------------- settings

  private applySettings(next: SettingsState, immediate = false): void {
    this.settings = { ...next };
    audio.setVolume(this.settings.masterVolume);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.effects.useDynamicLights = this.settings.quality !== 'low';
    this.renderer.shadowMap.enabled = this.settings.quality === 'high';
    this.renderer.setPixelRatio(this.settings.quality === 'low' ? 1 : Math.min(window.devicePixelRatio, 2));
    this.lights.castShadow = this.settings.quality === 'high';
    audio.play('ui_select', 0.3);
    void this.saves.storeSettings(this.settings);
    void immediate;
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private bindWindow(): void {
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('blur', () => {
      if (states.isPlaying() && !this.player.dead) this.openPause();
    });
  }

  // ------------------------------------------------------------------- misc

  private groundY(x: number, z: number): number {
    const hit = this.collision.raycast({ x, y: 60, z }, DOWN, 120);
    return hit ? hit.point.y : this.collision.surfaceHeight(x, z);
  }

  private reportDebug(): void {
    const info = this.renderer.info;
    const weapon = this.weapons.current;
    this.debug.update(0, {
      position: { x: this.controller.position.x, y: this.controller.position.y, z: this.controller.position.z },
      enemiesAlive: this.enemies.aliveCount,
      enemiesActive: this.enemies.enemies.length,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      playerLevel: this.player.level,
      currentWeapon: weapon ? `${weapon.name} (${weapon.ammo}/${weapon.magazineSize})` : 'none',
      pooledObjects: this.enemies.enemies.length + this.loot.items.length,
      state: states.state,
    });
  }

  private inventoryHost(): InventoryHost {
    const self = this;
    return {
      get backpack() {
        return self.backpack;
      },
      get salvage() {
        return self.salvage;
      },
      equipFromInventory(index: number) {
        const weapon = self.backpack[index];
        if (!weapon) return;
        self.backpack.splice(index, 1);
        const replaced = self.weapons.equip(weapon);
        if (replaced) self.backpack.push(replaced);
        audio.play('loot_pickup', 0.7);
      },
      dropFromInventory(index: number) {
        const weapon = self.backpack[index];
        if (!weapon) return;
        self.backpack.splice(index, 1);
        const forward = self.controller.forwardVector(self.tmpA.clone()).multiplyScalar(2);
        self.loot.dropWeapon(weapon, self.controller.position.clone().add(forward));
      },
      destroyFromInventory(index: number) {
        const weapon = self.backpack[index];
        if (!weapon) return;
        self.backpack.splice(index, 1);
        self.salvage += 15 + Math.round(weapon.level * 3);
        self.screens.toast('SALVAGED FOR PARTS', 1400);
      },
      unequipSlot(slot: number, drop = false) {
        const weapon = self.weapons.slots[slot];
        if (!weapon) return;
        if (!drop && self.backpack.length >= INVENTORY_SLOTS) {
          self.screens.toast('BACKPACK FULL', 1400);
          return;
        }
        self.weapons.slots[slot] = null;
        if (drop) {
          const forward = self.controller.forwardVector(self.tmpA.clone()).multiplyScalar(2);
          self.loot.dropWeapon(weapon, self.controller.position.clone().add(forward));
        } else {
          self.backpack.push(weapon);
        }
        if (!self.weapons.current) {
          const first = self.weapons.slots.findIndex((entry) => entry !== null);
          if (first >= 0) self.weapons.selectSlot(first);
        }
        self.weapons.setSlots(self.weapons.slots, Math.max(0, slot - 1));
      },
      addSalvage(amount: number) {
        self.salvage += amount;
      },
    };
  }

  // ----------------------------------------------------------------- dispose

  private buildLights(): THREE.DirectionalLight {
    this.scene.add(new THREE.HemisphereLight(0xffd9a0, 0x5d3a22, 0.95));
    const sun = new THREE.DirectionalLight(0xffe2b0, 1.15);
    sun.position.set(-90, 120, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 460;
    const span = 130;
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);
    this.scene.fog = new THREE.Fog(0xc99a63, 95, 330);
    return sun;
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
    window.removeEventListener('resize', this.resizeHandler);
    bus.offOwner(this);
    this.hud.dispose();
    this.screens.dispose();
    this.lootTooltip.dispose();
    this.inventoryUI.dispose();
    this.skillsUI.dispose();
    this.enemies.dispose();
    this.loot.dispose();
    this.effects.dispose();
    this.combat.dispose();
    this.drone.dispose();
    this.weapons.dispose();
    this.world.dispose();
    EnemyFactory.disposeShared();
    disposeSharedLootGeometries();
    this.renderer.dispose();
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const RESPAWN_ANCHOR = (world: World): { x: number; y: number; z: number } => world.anchors.playerSpawn;
