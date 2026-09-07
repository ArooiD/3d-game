import * as THREE from 'three';
import type { Weapon } from '../../../shared/types';
import { audio, shotSoundFor, SoundName } from '../audio/AudioSystem';
import { bus, GameEvents } from '../core/EventBus';
import type { CombatSystem } from '../combat/CombatSystem';
import type { EffectsSystem } from '../effects/EffectsSystem';
import { characterArmorColor, characterPalette } from '../player/CharacterModels';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerState } from '../player/PlayerState';
import { buildGunModel, fitGunLength, type GunModel } from './WeaponModels';

/**
 * Owns the three equipped slots, the viewmodel and every firing decision:
 * ammo, rate of fire, spread, recoil recovery, reloads and critical rolls.
 */

export interface FireContext {
  /** Applied after weapon damage, before crits. */
  damageMultiplier: number;
  fireRateMultiplier: number;
  spreadMultiplier: number;
  criticalChance: number;
  criticalMultiplier: number;
  reloadTimeMultiplier: number;
}

export interface WeaponHudState {
  name: string;
  type: string;
  rarity: string;
  level: number;
  ammo: number;
  magazine: number;
  reserve: number;
  reloading: boolean;
  slot: number;
}

/**
 * Rest and aim poses relative to the view camera. The weapon is held close -
 * a third of a meter from the eye - and the view camera's narrow FOV makes it
 * read large without the wide-angle distortion the world camera (up to 90 deg)
 * would otherwise apply to something that near.
 */
const VIEWMODEL_OFFSET = new THREE.Vector3(0.19, -0.17, -0.38);
/** Transitional aim pose; the final position is solved onto the view axis. */
const AIM_OFFSET = new THREE.Vector3(0, -0.08, -0.26);
/**
 * How far in front of the eye the optic sits while aiming. The sight anchor is
 * solved onto the view axis at exactly this depth, so the optic - red dot,
 * scope or iron notch - lands on the crosshair instead of beside it.
 */
const ADS_SIGHT_DEPTH = 0.3;
/** Viewmodel projection while aimed; narrower than the hip 55 deg. */
const ADS_VIEWMODEL_FOV = 44;
/** Blend rate per second for the ADS pose and the world zoom. */
const ADS_BLEND_RATE = 13;

export class WeaponController {
  readonly slots: (Weapon | null)[] = [null, null, null];
  activeSlot = 0;

  reloading = false;
  reloadProgress = 0;
  isAiming = false;
  /**
   * Aiming-down-sights blend: 0 at the hip, 1 fully on the sights. Drives the
   * world zoom, the viewmodel FOV and the sight alignment together so the three
   * can never disagree. Eased so raising the weapon reads as motion, not a snap.
   */
  private ads = 0;
  /** Zoom actually applied to the world camera, eased towards `targetAdsZoom`. */
  private appliedZoom = 1;
  /** Base world FOV supplied by settings; ADS divides into it. */
  private baseFov = 78;

  /** Recoil offsets, decayed back to zero each frame. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilKick = 0;
  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private nextFireAt = 0;
  private fireHeld = false;
  private burstPause = 0;

  private viewModel = new THREE.Group();
  /**
   * The weapon renders through its own camera into its own minimal scene. Sharing
   * the world camera made every gun look small and far: at 78+ degrees of FOV an
   * object 0.5 m from the eye covers a fraction of the screen, and real shooter
   * viewmodels are always drawn with a narrower projection. The scene is a handful
   * of lights plus the gun, so the extra pass costs one draw batch and no shadows.
   */
  readonly viewScene = new THREE.Scene();
  readonly viewCamera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 6);
  private viewLights: THREE.Light[] = [];
  private gun: GunModel | null = null;
  private lastMuzzleWorld = new THREE.Vector3();
  private muzzleGlow = 0;
  /** Rest transforms for the animated internals, captured when the gun is built. */
  private magRestY = 0;
  private boltRestZ = 0;
  private slideRestZ = 0;
  /** 0..1 bolt travel, snapped back on every shot. */
  private boltCycle = 1;
  private time = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    _scene: THREE.Scene,
    private combat: CombatSystem,
    private effects: EffectsSystem,
    private player: PlayerState,
    private controller: PlayerController,
  ) {
    this.viewModel.name = 'viewmodel';
    this.viewScene.name = 'view-scene';
    this.viewCamera.name = 'view-camera';
    this.viewScene.add(this.viewCamera);
    this.viewCamera.add(this.viewModel);

    // Lighting tuned for the gun alone: the world's sun is deliberately not
    // reused, so the weapon stays legible in caves, at night and in smoke.
    const key = new THREE.DirectionalLight(0xffe6c0, 1.35);
    key.position.set(-0.6, 1.1, 0.7);
    const fill = new THREE.DirectionalLight(0x8fa6c8, 0.55);
    fill.position.set(0.9, -0.2, 0.3);
    const ambient = new THREE.HemisphereLight(0xffd9a0, 0x40372c, 0.85);
    this.viewLights = [key, fill, ambient];
    this.viewScene.add(key, fill, ambient);
    if (!camera.parent) _scene.add(camera);
  }

  // ------------------------------------------------------------- inventory

  setSlots(slots: (Weapon | null)[], activeSlot = 0): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i] = slots[i] ?? null;
    }
    this.activeSlot = Math.max(0, Math.min(this.slots.length - 1, activeSlot));
    // Ensure at least one slot holds something playable.
    if (!this.current) {
      const firstFilled = this.slots.findIndex((entry) => entry !== null);
      this.activeSlot = firstFilled === -1 ? 0 : firstFilled;
    }
    this.reloading = false;
    this.buildViewmodel();
  }

  get current(): Weapon | null {
    return this.slots[this.activeSlot] ?? null;
  }

  selectSlot(index: number): boolean {
    if (index < 0 || index >= this.slots.length) return false;
    if (!this.slots[index]) {
      bus.emit(GameEvents.WeaponEmpty, { reason: 'empty_slot', slot: index });
      return false;
    }
    if (index === this.activeSlot) return false;
    this.activeSlot = index;
    this.reloading = false;
    this.reloadProgress = 0;
    this.nextFireAt = this.time + 0.22;
    this.buildViewmodel();
    audio.play(SoundName.Reload, 0.6);
    const weapon = this.current;
    if (weapon) {
      bus.emit(GameEvents.WeaponEquipped, { weapon, slot: index });
    }
    return true;
  }

  /** Picks the best empty slot, else replaces the active one. */
  private allocateSlot(): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]) return i;
    }
    return this.activeSlot;
  }

  /** Equips into a slot and returns whatever it displaced (for the backpack). */
  equip(weapon: Weapon, slot?: number): Weapon | null {
    const target = slot ?? this.allocateSlot();
    const replaced = this.slots[target] ?? null;
    this.slots[target] = weapon;
    this.activeSlot = Math.max(0, Math.min(this.slots.length - 1, target));
    this.reloading = false;
    this.reloadProgress = 0;
    this.buildViewmodel();
    bus.emit(GameEvents.WeaponEquipped, { weapon, slot: this.activeSlot });
    return replaced;
  }

  clearSlots(): void {
    for (let i = 0; i < this.slots.length; i++) this.slots[i] = null;
    this.buildViewmodel();
  }

  // ---------------------------------------------------------------- firing

  /** Refills from the viewmodel position, called by the app each frame. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.lastMuzzleWorld);
  }

  tryReload(): boolean {
    const weapon = this.current;
    if (!weapon || this.reloading) return false;
    if (weapon.ammo >= weapon.magazineSize) return false;
    if (weapon.reserveAmmo <= 0) {
      audio.play(SoundName.DryFire);
      bus.emit(GameEvents.WeaponEmpty, { reason: 'no_reserve', slot: this.activeSlot });
      return false;
    }
    this.reloading = true;
    this.reloadProgress = 0;
    audio.play(SoundName.Reload);
    return true;
  }

  private finishReload(): void {
    const weapon = this.current;
    this.reloading = false;
    this.reloadProgress = 0;
    if (!weapon) return;
    const needed = weapon.magazineSize - weapon.ammo;
    const taken = Math.min(needed, weapon.reserveAmmo);
    weapon.ammo += taken;
    weapon.reserveAmmo -= taken;
    bus.emit(GameEvents.WeaponReloaded, { weapon, slot: this.activeSlot });
  }

  private spreadFor(weapon: Weapon, context: FireContext): number {
    const base = weapon.spread ?? 0.02;
    // Accuracy stat tightens the cone; movement and jumping widen it.
    const accuracyScale = THREE.MathUtils.lerp(1.5, 0.55, Math.max(0, Math.min(1, weapon.accuracy)));
    const speed = Math.hypot(this.controller.velocity.x, this.controller.velocity.z);
    const movePenalty = 1 + Math.min(1.6, speed / Math.max(1, this.player.stats.sprintSpeed) * 1.2);
    const airPenalty = this.controller.grounded ? 1 : 1.8;
    const aimScale = this.isAiming ? 0.42 : 1;
    const recoilPenalty = 1 + Math.min(1.4, Math.abs(this.recoilPitch) * 9);
    return base * accuracyScale * movePenalty * airPenalty * aimScale * recoilPenalty * context.spreadMultiplier;
  }

  /** Returns true when a shot actually went off this frame. */
  tryFire(context: FireContext, held: boolean, pressed: boolean): boolean {
    const weapon = this.current;
    if (!weapon || this.player.dead) return false;

    // Auto weapons fire while held, others only on the press edge.
    const wantsFire = weapon.auto ? held : pressed;
    if (!wantsFire) {
      this.fireHeld = held;
      return false;
    }
    const isFreshPress = !this.fireHeld;

    if (this.reloading) return false;
    if (this.time < this.nextFireAt) return false;
    if (this.burstPause > 0) return false;

    if (weapon.ammo <= 0) {
      if (isFreshPress) {
        audio.play(SoundName.DryFire);
        bus.emit(GameEvents.WeaponEmpty, { reason: 'magazine', slot: this.activeSlot });
        this.nextFireAt = this.time + 0.32;
        this.tryReload();
      }
      this.fireHeld = true;
      return false;
    }

    // ---- fire ----------------------------------------------------------
    weapon.ammo -= 1;
    this.fireHeld = true;
    const rate = Math.max(0.2, weapon.fireRate * context.fireRateMultiplier);
    this.nextFireAt = this.time + 1 / rate;

    const origin = this.lastMuzzleWorld.clone();
    const direction = this.controller.aimDirection(new THREE.Vector3());
    const spread = this.spreadFor(weapon, context);

    const results = this.combat.fireHitscan({
      origin,
      direction,
      weapon,
      damage: weapon.damage * this.player.stats.weaponDamageModifier * context.damageMultiplier,
      criticalChance: context.criticalChance,
      criticalMultiplier: context.criticalMultiplier * weapon.criticalMultiplier,
      spread,
      shieldBonus: 0,
      source: 'player',
    });

    // Feedback: flash, tracer, sound, recoil, shake.
    this.effects.muzzleFlash(origin, direction, weapon.weaponType === 'shotgun' ? 1.7 : 1);
    const first = results[0];
    if (first) {
      this.effects.tracer(origin, first.point, undefined, weapon.weaponType === 'sniper_rifle' ? 2 : 1);
    } else {
      const far = origin.clone().addScaledVector(direction, weapon.range);
      this.effects.tracer(origin, far, undefined, 0.6);
    }
    audio.play(shotSoundFor(weapon.weaponType));
    // Cycle the action and flash the rarity emissive.
    this.boltCycle = 0;
    this.muzzleGlow = 1;

    const recoil = weapon.recoil * (this.isAiming ? 0.6 : 1);
    this.recoilPitch += recoil;
    this.recoilYaw += (Math.random() - 0.5) * recoil * 0.7;
    this.recoilKick = Math.min(0.14, this.recoilKick + recoil * 0.55);
    this.controller.addShake(weapon.shake * (this.isAiming ? 0.55 : 1) * 0.32);

    bus.emit(GameEvents.WeaponFired, {
      weapon,
      slot: this.activeSlot,
      hits: results.filter((entry) => entry.target).length,
      muzzle: origin,
      direction,
    });

    if (weapon.ammo <= 0) {
      this.burstPause = 0.18;
      this.tryReload();
    }
    return true;
  }

  /** Applies the pitch/yaw a shot cost, so the player must counter recoil. */
  private applyRecoil(): void {
    if (Math.abs(this.recoilPitch) < 1e-5 && Math.abs(this.recoilYaw) < 1e-5) return;
    this.controller.pitch = Math.min(Math.PI / 2 - 0.02, this.controller.pitch + this.recoilPitch);
    this.controller.yaw += this.recoilYaw;
    // Recoil decays back down, giving the classic recovery window.
    this.recoilPitch *= 0.62;
    this.recoilYaw *= 0.55;
    if (Math.abs(this.recoilPitch) < 0.00035) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 0.00035) this.recoilYaw = 0;
  }

  // ---------------------------------------------------------------- update

  update(
    dt: number,
    context: FireContext,
    input: { fireHeld: boolean; firePressed: boolean; aiming: boolean },
  ): void {
    this.time += dt;
    this.burstPause = Math.max(0, this.burstPause - dt);
    this.isAiming = input.aiming;

    // ADS blend and the world zoom it drives. Zooming the projection (rather than
    // only sliding the gun) is what makes aiming read as aiming; it is eased so
    // the screen does not lurch, and clamped so a high base FOV cannot invert it.
    const adsTarget = this.isAiming && !this.reloading ? 1 : 0;
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * ADS_BLEND_RATE);
    if (this.ads < 0.0005) this.ads = 0;
    if (this.ads > 0.9995) this.ads = 1;

    const held = this.current;
    const zoom = held ? Math.max(1, held.adsZoom ?? 1) : 1;
    const wantedZoom = 1 + (zoom - 1) * this.ads;
    this.appliedZoom += (wantedZoom - this.appliedZoom) * Math.min(1, dt * ADS_BLEND_RATE);
    if (Math.abs(this.appliedZoom - wantedZoom) < 0.001) this.appliedZoom = wantedZoom;
    const fov = this.baseFov / this.appliedZoom;
    if (Math.abs(this.camera.fov - fov) > 0.001) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    if (this.reloading) {
      const weapon = this.current;
      const duration = weapon ? weapon.reloadTime * context.reloadTimeMultiplier : 2;
      this.reloadProgress += dt / Math.max(0.2, duration);
      if (this.reloadProgress >= 1) this.finishReload();
    }

    this.tryFire(context, input.fireHeld, input.firePressed);
    this.applyRecoil();
    this.recoilKick *= Math.exp(-dt * 11);

    this.updateViewmodel(dt);
  }

  private updateViewmodel(dt: number): void {
    // The view camera mirrors the eye every frame, so the weapon inherits look
    // direction, recoil and screen shake exactly like a parented viewmodel would.
    this.camera.updateWorldMatrix(true, false);
    this.viewCamera.position.setFromMatrixPosition(this.camera.matrixWorld);
    this.viewCamera.quaternion.setFromRotationMatrix(this.camera.matrixWorld);
    this.viewCamera.aspect = this.camera.aspect;

    const weapon = this.current;
    if (!weapon) {
      this.viewModel.visible = false;
      return;
    }
    this.viewModel.visible = true;

    const speed = Math.hypot(this.controller.velocity.x, this.controller.velocity.z);
    const moveAmount = Math.min(1, speed / Math.max(1, this.player.stats.sprintSpeed));
    this.bobPhase += dt * (7 + moveAmount * 6);
    // Standing still steadies the hands; aiming wants the gun rock steady.
    const steadiness = moveAmount * (1 - this.ads * 0.75);
    const bobX = Math.cos(this.bobPhase) * 0.008 * steadiness;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.009 * steadiness;

    const target = this.isAiming ? AIM_OFFSET : VIEWMODEL_OFFSET;
    const base = this.viewModel.position;
    const blend = Math.min(1, dt * (this.isAiming ? 14 : 9));
    base.lerp(TEMP_TARGET.set(target.x, target.y, target.z), blend);

    // Landing dip + firing kick along the view axis.
    base.y -= this.controller.velocity.y < -6 ? 0.02 : 0;
    base.z += this.recoilKick;
    base.x += bobX;
    base.y += bobY - this.recoilKick * 0.35;

    this.viewModel.rotation.set(
      -this.recoilKick * 2.6 + (this.reloading ? Math.sin(this.reloadProgress * Math.PI * 3) * 0.3 : 0),
      this.reloading ? Math.sin(this.reloadProgress * Math.PI) * 0.5 : 0,
      this.reloading ? Math.sin(this.reloadProgress * Math.PI) * 0.25 : bobX * 1.4,
    );

    const swayTargetX = THREE.MathUtils.clamp(-this.controller.velocity.x * 0.004, -0.02, 0.02);
    const swayTargetY = THREE.MathUtils.clamp(-this.controller.velocity.z * 0.003, -0.02, 0.02);
    const swayDamp = 1 - this.ads;
    this.swayX = THREE.MathUtils.lerp(this.swayX, swayTargetX * swayDamp, Math.min(1, dt * 6));
    this.swayY = THREE.MathUtils.lerp(this.swayY, swayTargetY * swayDamp, Math.min(1, dt * 6));
    this.viewModel.position.x += this.swayX;
    this.viewModel.position.y += this.swayY;

    // Aiming solves for the pose instead of nudging it: the optic's centre is
    // pushed onto the view axis at a fixed depth, so whatever the archetype uses -
    // red dot, scope or open iron sights - it frames exactly what the crosshair
    // frames. Hip pose and solved pose are blended by `ads`, so raising the weapon
    // is one continuous move rather than a jump between two anchors.
    if (this.ads > 0.001 && this.gun) {
      const sightLocal = TEMP_SIGHT.copy(this.gun.sights.position)
        .multiplyScalar(this.gun.group.scale.z || 1)
        .applyQuaternion(this.viewModel.quaternion);
      TEMP_AIM_TARGET.set(0, 0, -ADS_SIGHT_DEPTH).sub(sightLocal);
      base.lerpVectors(base, TEMP_AIM_TARGET, this.ads);
    }

    this.viewCamera.fov = THREE.MathUtils.lerp(55, ADS_VIEWMODEL_FOV, this.ads);
    this.viewCamera.updateProjectionMatrix();

    // World-space muzzle position for tracers and effects.
    const gun = this.gun;
    if (gun) {
      gun.muzzle.getWorldPosition(this.lastMuzzleWorld);
      this.animateInternals(dt);
    } else {
      this.camera.getWorldPosition(this.lastMuzzleWorld);
    }
  }

  /** Drives the magazine drop, bolt cycling, pump stroke and rarity glow. */
  private animateInternals(dt: number): void {
    const gun = this.gun;
    if (!gun) return;

    // Bolt: kicked back by the shot, then springs forward.
    this.boltCycle = Math.min(1, this.boltCycle + dt * (this.current ? this.current.fireRate * 1.6 + 6 : 8));
    if (gun.bolt) {
      const travel = this.reloading ? Math.sin(Math.min(1, this.reloadProgress * 2) * Math.PI) : 1 - this.boltCycle;
      gun.bolt.position.z = this.boltRestZ + travel * 0.045;
    }

    // Reload: mag drops out and a fresh one slides back in.
    if (gun.magazine) {
      if (this.reloading) {
        const drop = Math.sin(Math.min(1, this.reloadProgress * 1.35) * Math.PI);
        gun.magazine.position.y = this.magRestY - drop * 0.22;
        gun.magazine.rotation.x = drop * 0.25;
        gun.magazine.visible = this.reloadProgress < 0.55 || this.reloadProgress > 0.62;
      } else {
        gun.magazine.position.y = this.magRestY;
        gun.magazine.rotation.x = 0;
        gun.magazine.visible = true;
      }
    }

    // Pump-action shotgun strokes on every shot.
    if (gun.slide) {
      const stroke = (1 - this.boltCycle) * 0.09;
      gun.slide.position.z = this.slideRestZ + stroke;
    }

    // Rarity emissive pulses on fire and fades out.
    this.muzzleGlow = Math.max(0, this.muzzleGlow - dt * 4.5);
    gun.setGlow(this.muzzleGlow);
  }

  // ------------------------------------------------------------- viewmodel

  private buildViewmodel(): void {
    this.gun?.dispose();
    this.gun = null;
    for (const child of [...this.viewModel.children]) {
      this.viewModel.remove(child);
    }

    const weapon = this.current;
    if (!weapon) return;

    const model = buildGunModel(weapon, {
      detail: 'high',
      hands: true,
      armorColor: characterArmorColor(this.player.characterId),
      armorAccent: characterPalette(this.player.characterId).accent,
    });
    // Real guns are 0.3-1.2 m; the viewmodel keeps a compact, readable size.
    fitGunLength(model, weapon.weaponType === 'sniper_rifle' ? 0.86 : 0.62);
    this.viewModel.add(model.group);
    this.gun = model;

    this.magRestY = model.magazine ? model.magazine.position.y : 0;
    this.boltRestZ = model.bolt ? model.bolt.position.z : 0;
    this.slideRestZ = model.slide ? model.slide.position.z : 0;
  }

  get hudState(): WeaponHudState {
    const weapon = this.current;
    if (!weapon) {
      return {
        name: 'NO WEAPON',
        type: '—',
        rarity: 'common',
        level: 1,
        ammo: 0,
        magazine: 0,
        reserve: 0,
        reloading: false,
        slot: this.activeSlot,
      };
    }
    return {
      name: weapon.name,
      type: weapon.weaponType,
      rarity: weapon.rarity,
      level: weapon.level,
      ammo: weapon.ammo,
      magazine: weapon.magazineSize,
      reserve: weapon.reserveAmmo,
      reloading: this.reloading,
      slot: this.activeSlot,
    };
  }

  /** Fills every magazine from a shared reserve pool (respawn / ammo pickup). */
  topUpAmmo(ratio = 1): void {
    for (const weapon of this.slots) {
      if (!weapon) continue;
      const needed = weapon.magazineSize - weapon.ammo;
      const take = Math.round(needed * ratio);
      const available = Math.max(0, Math.min(weapon.reserveAmmo, take));
      weapon.ammo += available;
      weapon.reserveAmmo -= available;
    }
  }

  /**
   * 0 at the hip, 1 fully on the sights. HUD and camera code read this instead of
   * the raw key state so their transitions match the weapon's exactly.
   */
  get aimBlend(): number {
    return this.ads;
  }

  /** Current world zoom, e.g. 2.9 for an aimed sniper. Never below 1. */
  get aimZoom(): number {
    return this.appliedZoom;
  }

  /** Optic fitted to the equipped weapon, selecting the HUD reticle. */
  get opticsKind(): 'none' | 'red-dot' | 'optic' | 'scope' {
    return this.gun?.optics ?? 'none';
  }

  /**
   * World FOV at the hip. Settings own this value; aiming divides into it so the
   * player's FOV preference and the zoom always compose correctly.
   */
  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  /**
   * Draws the weapon over the world. Called by the app after the main pass; the
   * depth buffer is kept so the gun always wins against the terrain in front of
   * it (nothing in hand should ever be occluded by a wall it is touching).
   */
  renderViewmodel(renderer: THREE.WebGLRenderer): void {
    if (!this.gun || !this.viewModel.visible) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.viewScene, this.viewCamera);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.viewModel.removeFromParent();
    for (const light of this.viewLights) light.dispose();
    this.viewLights.length = 0;
    this.viewCamera.clear();
    this.viewScene.clear();
    this.gun?.dispose();
    this.gun = null;
  }
}

const TEMP_TARGET = new THREE.Vector3();
const TEMP_SIGHT = new THREE.Vector3();
const TEMP_AIM_TARGET = new THREE.Vector3();
