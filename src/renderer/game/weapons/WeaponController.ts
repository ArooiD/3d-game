import * as THREE from 'three';
import type { Weapon } from '../../../shared/types';
import { audio, shotSoundFor, SoundName } from '../audio/AudioSystem';
import { bus, GameEvents } from '../core/EventBus';
import type { CombatSystem } from '../combat/CombatSystem';
import type { EffectsSystem } from '../effects/EffectsSystem';
import type { PlayerController } from '../player/PlayerController';
import type { PlayerState } from '../player/PlayerState';
import { baseFor } from '../../data/weapons/weaponBases';

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
  private gunMaterial: THREE.MeshLambertMaterial | null = null;
  private barrelMesh: THREE.Mesh | null = null;
  private readonly gunGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly magGeometry = new THREE.BoxGeometry(0.5, 0.9, 0.28);
  private magMesh: THREE.Mesh | null = null;
  private magMaterial: THREE.MeshLambertMaterial | null = null;
  private lastMuzzleWorld = new THREE.Vector3();
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
    if (this.barrelMesh) {
      this.barrelMesh.getWorldPosition(this.lastMuzzleWorld);
      this.lastMuzzleWorld.addScaledVector(TEMP_FWD.set(0, 0, -1).applyQuaternion(this.camera.quaternion), 0.28);
    } else {
      this.camera.getWorldPosition(this.lastMuzzleWorld);
    }

    // Reload drops the magazine mesh out of the gun.
    if (this.magMesh) {
      this.magMesh.visible = this.gunMaterial !== null;
      this.magMesh.position.y = this.reloading ? -0.16 - Math.sin(this.reloadProgress * Math.PI) * 0.16 : -0.12;
    }
  }

  // ------------------------------------------------------------- viewmodel

  private buildViewmodel(): void {
    for (const child of [...this.viewModel.children]) {
      this.viewModel.remove(child);
    }
    this.barrelMesh = null;
    this.magMesh = null;
    this.gunMaterial = null;

    const weapon = this.current;
    if (!weapon) return;

    const base = baseFor(weapon.weaponType);
    const scale = weapon.modelScale ?? base.modelScale;
    const color = weapon.modelColor ?? base.modelColor;

    this.gunMaterial = new THREE.MeshLambertMaterial({ color, emissive: 0x0a0d12 });
    const gun = new THREE.Mesh(this.gunGeometry, this.gunMaterial);
    gun.scale.set(scale[0], scale[1], scale[2]);
    gun.position.set(0, 0, -scale[2] * 0.35);
    this.viewModel.add(gun);

    const magGeometry = this.magGeometry;
    this.magMaterial = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
    const mag = new THREE.Mesh(magGeometry, this.magMaterial);
    mag.scale.set(Math.max(0.06, scale[0] * 0.85), Math.max(0.1, scale[1] * 1.3), Math.max(0.06, scale[2] * 0.4));
    mag.position.set(0, -scale[1] * 0.9, -scale[2] * 0.18);
    this.viewModel.add(mag);
    this.magMesh = mag;

    // Sniper rifles get a scope, shotguns a wider muzzle, SMGs a foregrip.
    if (weapon.weaponType === 'sniper_rifle') {
      const scope = new THREE.Mesh(this.gunGeometry, this.magMaterial);
      scope.scale.set(0.06, 0.06, 0.3);
      scope.position.set(0, scale[1] * 0.85, -scale[2] * 0.42);
      this.viewModel.add(scope);
    }
    if (weapon.weaponType === 'shotgun') {
      const second = new THREE.Mesh(this.gunGeometry, this.gunMaterial);
      second.scale.set(scale[0] * 0.62, scale[1] * 0.62, scale[2] * 0.86);
      second.position.set(0, -scale[1] * 0.42, -scale[2] * 0.5);
      this.viewModel.add(second);
    }

    const barrel = new THREE.Mesh(this.gunGeometry, this.gunMaterial);
    barrel.scale.set(Math.max(0.03, scale[0] * 0.4), Math.max(0.03, scale[1] * 0.4), Math.max(0.05, scale[2] * 0.22));
    barrel.position.set(0, 0, -scale[2] * 0.98);
    this.viewModel.add(barrel);
    this.barrelMesh = barrel;

    // Rarity tint on the receiver so a good drop is visible in-hand.
    const rarityGlow = RARITY_EMISSIVE[weapon.rarity];
    if (rarityGlow !== undefined) this.gunMaterial.emissive.setHex(rarityGlow);
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
    this.gunGeometry.dispose();
    this.magGeometry.dispose();
    this.gunMaterial?.dispose();
    this.magMaterial?.dispose();
  }
}

const RARITY_EMISSIVE: Record<string, number> = {
  common: 0x0a0d12,
  uncommon: 0x0f2a17,
  rare: 0x0f2140,
  epic: 0x240f40,
  legendary: 0x3d2606,
};

const TEMP_TARGET = new THREE.Vector3();
const TEMP_FWD = new THREE.Vector3();
