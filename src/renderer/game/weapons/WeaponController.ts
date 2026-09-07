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

const VIEWMODEL_OFFSET = new THREE.Vector3(0.26, -0.24, -0.52);
const AIM_OFFSET = new THREE.Vector3(0, -0.115, -0.34);

export class WeaponController {
  readonly slots: (Weapon | null)[] = [null, null, null];
  activeSlot = 0;

  reloading = false;
  reloadProgress = 0;
  isAiming = false;

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
    this.camera.add(this.viewModel);
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
    const weapon = this.current;
    if (!weapon) {
      this.viewModel.visible = false;
      return;
    }
    this.viewModel.visible = true;

    const speed = Math.hypot(this.controller.velocity.x, this.controller.velocity.z);
    const moveAmount = Math.min(1, speed / Math.max(1, this.player.stats.sprintSpeed));
    this.bobPhase += dt * (7 + moveAmount * 6);
    const bobX = Math.cos(this.bobPhase) * 0.012 * moveAmount;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.014 * moveAmount;

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
    this.swayX = THREE.MathUtils.lerp(this.swayX, swayTargetX, Math.min(1, dt * 6));
    this.swayY = THREE.MathUtils.lerp(this.swayY, swayTargetY, Math.min(1, dt * 6));
    this.viewModel.position.x += this.swayX;
    this.viewModel.position.y += this.swayY;

    // World-space muzzle position for tracers and effects.
    const gun = this.gun;
    if (gun) {
      gun.muzzle.getWorldPosition(this.lastMuzzleWorld);
      this.lastMuzzleWorld.addScaledVector(TEMP_FWD.set(0, 0, -1).applyQuaternion(this.camera.quaternion), 0.28);
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

  get aimBlend(): number {
    return this.isAiming ? 1 : 0;
  }

  dispose(): void {
    this.viewModel.removeFromParent();
    this.gun?.dispose();
    this.gun = null;
  }
}

const TEMP_TARGET = new THREE.Vector3();
const TEMP_FWD = new THREE.Vector3();
