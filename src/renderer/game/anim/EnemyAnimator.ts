import * as THREE from 'three';
import type { BoneName, Skeleton } from './Rig';
import { Pose } from './Rig';
import {
  alertAdd,
  aimAdd,
  bossDeath,
  braceAdd,
  crouchAdd,
  deathFall,
  fireAdd,
  gait,
  hitAdd,
  idle,
  IDLE_VARIANTS,
  patrolAdd,
  retreatAdd,
  RUN,
  strideRate,
  swingAdd,
  WALK,
  windupAdd,
  type GaitParams,
} from './Clips';

/**
 * Evaluates animation for one enemy rig.
 *
 * Layer order mirrors the approach used by the MIT-licensed Claude-of-Duty
 * animator (see NOTICE): a locomotion base (idle <-> walk <-> run crossfaded on
 * real ground speed so feet do not skate), additive combat layers on top, then
 * one-shot layers (hit reaction, death) that fade the base out. Everything is
 * preallocated; `update()` does not allocate.
 */

export interface EnemyAnimContext {
  /** Ground speed this frame in m/s. */
  speed: number;
  /** The enemy's own move speed, used to normalise the gait blend. */
  moveSpeed: number;
  state: 'idle' | 'patrol' | 'alert' | 'chase' | 'attack' | 'retreat' | 'dead';
  /** Seconds since the last shot landed (drives the recoil layer). */
  sinceShot: number;
  /** Seconds since the last hit taken. */
  sinceHit: number;
  hitRegion: 0 | 1;
  hitSide: number;
  /** 0..1 melee windup / swing progress, negative when not swinging. */
  swing: number;
  /** Melee units drive `swing`; ranged units drive `sinceShot`. */
  melee: boolean;
  aiming: boolean;
  crouched: boolean;
  braced: boolean;
  alerted: number;
  boss: boolean;
  /** 0..1 death progress, negative while alive. */
  death: number;
  dt: number;
}

const BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'armL',
  'forearmL',
  'shoulderR',
  'armR',
  'forearmR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
] as const satisfies readonly BoneName[];

/**
 * Persistent two-handed low-ready pose for ordinary ranged enemies.
 *
 * Enemy gun geometry is parented to forearmR. The upper arm therefore only needs
 * a moderate forward swing: the elbow stays clearly below the shoulder while the
 * forearm counter-rotates enough to bring the weapon across the torso. This reads
 * as a real low-ready carry instead of either a dangling one-hand grip or a T pose.
 */
function rangedCarryAdd(P: Pose, weight = 1, combatReady = false): void {
  const ready = combatReady ? 1 : 0.9;
  const w = weight * ready;

  P.add('chest', combatReady ? 1.5 : 0.5, 0, 0, w);
  P.add('shoulderR', -3, -1, 4, w);
  P.add('armR', 28, -2, 2, w);
  P.add('forearmR', -20, 1, 0, w);

  P.add('shoulderL', -4, 2, -7, w);
  P.add('armL', 32, 3, -3, w);
  P.add('forearmL', -23, -2, 0, w);
}

export class EnemyAnimator {
  /** Stride phase, advanced by measured distance so footsteps match speed. */
  private phase: number;
  private idleTime: number;
  private idleAge = 0;
  private idleVariant: number;
  private previousIdle: number;
  private idleTransition = 1;
  private idleDuration: number;
  private idleTempo: number;
  private combatWeight = 0;
  private aimWeight = 0;
  private base = new Pose();
  private layer = new Pose();
  private scratch = new THREE.Vector3();
  private walkWeight = 0;
  private runWeight = 0;
  private idleWeight = 1;

  /** Optional seed makes pose sequences reproducible in tests and previews. */
  constructor(private skeleton: Skeleton, seed = Math.random()) {
    const value = Number.isFinite(seed) ? ((seed % 1) + 1) % 1 : 0;
    this.phase = value;
    this.idleTime = value * 37;
    this.idleTempo = .85 + value * .3;
    this.idleDuration = 6 + value * 4;
    this.idleVariant = Math.floor(value * IDLE_VARIANTS.length);
    this.previousIdle = this.idleVariant;
    // A newly spawned actor is already posed, before its first AI update.
    idle(this.base, this.idleTime, 1, IDLE_VARIANTS[this.idleVariant]!);
    this.apply(this.base);
  }

  update(context: EnemyAnimContext): void {
    const dt = Number.isFinite(context.dt) ? THREE.MathUtils.clamp(context.dt, 0, .1) : 0;
    const base = this.base;
    const layer = this.layer;
    base.reset();
    layer.reset();

    // --- one-shot death takes the whole rig --------------------------------
    if (context.death >= 0) {
      const t = Math.min(1, context.death);
      if (context.boss) bossDeath(base, t);
      else deathFall(base, t, context.state === 'retreat');
      this.apply(base);
      this.applyRoot(base);
      return;
    }

    // --- locomotion base ----------------------------------------------------
    const maxSpeed = Math.max(0.5, context.moveSpeed);
    const normalised = Math.min(1.35, context.speed / maxSpeed);
    this.phase = (this.phase + dt * strideRate(context.speed, maxSpeed, WALK.cycle)) % 1;

    // Crossfade: standstill -> walk -> run.
    const walkTarget = THREE.MathUtils.clamp((normalised - 0.02) / 0.55, 0, 1);
    const runTarget = THREE.MathUtils.clamp((normalised - 0.55) / 0.5, 0, 1);
    const blend = Math.min(1, dt * 9);
    this.walkWeight += (walkTarget - this.walkWeight) * blend;
    this.runWeight += (runTarget - this.runWeight) * blend;
    this.idleWeight = Math.max(0, 1 - this.walkWeight * 1.15);

    this.idleTime += dt * this.idleTempo;
    const combat = context.aiming || context.melee && context.swing >= 0 ||
      context.state === 'alert' || context.state === 'attack' || context.state === 'chase' || context.state === 'retreat';
    this.combatWeight += ((combat ? 1 : 0) - this.combatWeight) * (1 - Math.exp(-dt * 12));
    if (!combat && normalised < .05) {
      this.idleAge += dt;
      if (this.idleAge >= this.idleDuration) {
        this.idleAge -= this.idleDuration;
        this.previousIdle = this.idleVariant;
        this.idleVariant = (this.idleVariant + 1) % IDLE_VARIANTS.length;
        this.idleTransition = 0;
      }
    }
    this.idleTransition = Math.min(1, this.idleTransition + dt / 1.2);
    if (this.idleWeight > .001) {
      const t = this.idleTransition;
      const mix = t * t * (3 - 2 * t);
      const gestures = (1 - this.combatWeight) * (context.boss ? .35 : 1);
      idle(base, this.idleTime, this.idleWeight * (1 - mix), IDLE_VARIANTS[this.previousIdle]!, gestures);
      idle(base, this.idleTime, this.idleWeight * mix, IDLE_VARIANTS[this.idleVariant]!, gestures);
    }
    if (this.walkWeight > 0.001 && this.runWeight < 0.999) {
      gait(base, this.phase, WALK, this.walkWeight * (1 - this.runWeight));
    }
    if (this.runWeight > 0.001) {
      gait(base, this.phase * RUN.cycle / WALK.cycle, RUN, this.runWeight);
    }

    // --- additive combat layers --------------------------------------------
    this.aimWeight += ((context.aiming ? 1 : 0) - this.aimWeight) * (1 - Math.exp(-dt * 12));

    // Raider/heavy/sniper weapons used to hang from the right hand because the
    // default rig only raised the arms while actively shooting. Keep a two-hand
    // carry pose alive for every ordinary ranged enemy, then reduce its weight
    // while the stronger ADS pose takes over. Boss weapons are integrated into
    // their forearms and deliberately keep the boss-specific animation.
    if (!context.melee && !context.boss) {
      const carryWeight = 1 - this.aimWeight * 0.55;
      const combatReady = context.state === 'alert' || context.state === 'chase' ||
        context.state === 'attack' || context.state === 'retreat';
      rangedCarryAdd(layer, carryWeight, combatReady);
    }

    if (this.aimWeight > .001) aimAdd(layer, .9 * this.aimWeight);
    if (context.braced) braceAdd(layer, 1);
    if (context.crouched) crouchAdd(layer, 1);
    if (context.state === 'patrol') patrolAdd(layer, this.phase, 1);
    if (context.state === 'retreat') retreatAdd(layer, this.phase, 1);
    if (context.alerted >= 0) alertAdd(layer, context.alerted, 1);

    if (context.melee && context.swing >= 0) {
      swingAdd(layer, THREE.MathUtils.clamp(context.swing, 0, 1), 1);
    } else if (context.sinceShot >= 0) {
      // Shot duration is ~0.22s; the layer decays across it.
      const t = context.sinceShot / 0.22;
      if (t <= 1) {
        if (context.state === 'attack' && context.melee === false) windupAdd(layer, 1 - t, 0.5);
        fireAdd(layer, t, context.aiming ? 1 : 0.75);
      }
    }

    if (context.sinceHit >= 0) {
      const t = context.sinceHit / 0.34;
      if (t <= 1) hitAdd(layer, context.hitRegion, t, context.hitSide, 1 - t * 0.35);
    }

    this.applyBlended(base, layer);
    this.applyRoot(base);
  }

  /** Writes bind + pose deltas onto the bones. */
  private apply(pose: Pose): void {
    for (const bone of BONES) {
      const node = this.skeleton.bones.get(bone);
      if (!node) continue;
      this.skeleton.bindInto(bone, node.rotation);
      pose.get(bone, this.scratch);
      node.rotation.x += THREE.MathUtils.degToRad(this.scratch.x);
      node.rotation.y += THREE.MathUtils.degToRad(this.scratch.y);
      node.rotation.z += THREE.MathUtils.degToRad(this.scratch.z);
    }
  }

  private applyBlended(base: Pose, layer: Pose): void {
    for (const bone of BONES) {
      const node = this.skeleton.bones.get(bone);
      if (!node) continue;
      this.skeleton.bindInto(bone, node.rotation);
      base.get(bone, this.scratch);
      let x = this.scratch.x;
      let y = this.scratch.y;
      let z = this.scratch.z;
      layer.get(bone, this.scratch);
      x += this.scratch.x;
      y += this.scratch.y;
      z += this.scratch.z;
      node.rotation.x += THREE.MathUtils.degToRad(x);
      node.rotation.y += THREE.MathUtils.degToRad(y);
      node.rotation.z += THREE.MathUtils.degToRad(z);
    }
  }

  private applyRoot(pose: Pose): void {
    const root = this.skeleton.root;
    root.position.y = pose.hipY;
    root.rotation.x = THREE.MathUtils.degToRad(pose.hipPitch);
    root.rotation.z = THREE.MathUtils.degToRad(pose.hipRoll);
    root.rotation.y = THREE.MathUtils.degToRad(pose.hipYaw);
  }

  /** Nudge the stride phase so a step lands when an attack starts. */
  syncPhase(): void {
    this.phase = 0.12;
  }
}

export type { GaitParams };
