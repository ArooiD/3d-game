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

export class EnemyAnimator {
  /** Stride phase, advanced by measured distance so footsteps match speed. */
  private phase = Math.random();
  private base = new Pose();
  private layer = new Pose();
  private scratch = new THREE.Vector3();
  private walkWeight = 0;
  private runWeight = 0;
  private idleWeight = 1;

  constructor(private skeleton: Skeleton) {}

  update(context: EnemyAnimContext): void {
    const { dt } = context;
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

    if (this.idleWeight > 0.001) idle(base, this.phase, this.idleWeight);
    if (this.walkWeight > 0.001 && this.runWeight < 0.999) {
      gait(base, this.phase, WALK, this.walkWeight * (1 - this.runWeight));
    }
    if (this.runWeight > 0.001) {
      gait(base, this.phase * RUN.cycle / WALK.cycle, RUN, this.runWeight);
    }

    // --- additive combat layers --------------------------------------------
    if (context.aiming) aimAdd(layer, 0.9);
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
