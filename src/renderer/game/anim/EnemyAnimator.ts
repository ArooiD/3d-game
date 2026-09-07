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

type BrokenParts = Partial<Record<'head' | 'torso' | 'armL' | 'armR' | 'legL' | 'legR' | 'weapon', boolean>>;
const NO_BROKEN_PARTS: BrokenParts = Object.freeze({});

/**
 * Persistent two-handed low-ready pose for ordinary ranged enemies.
 *
 * Enemy gun geometry is parented to forearmR. The idle carry therefore relies
 * mostly on inward shoulder roll and a modest elbow bend, keeping both elbows
 * visibly below the shoulders. Combat ADS supplies the larger forward raise.
 */
function rangedCarryAdd(P: Pose, weight = 1, combatReady = false): void {
  const ready = combatReady ? 1 : 0.9;
  const w = weight * ready;

  P.add('chest', combatReady ? 1.5 : 0.5, 0, 0, w);
  P.add('shoulderR', -2, -2, 8, w);
  P.add('armR', 14, -4, 3, w);
  P.add('forearmR', -8, 2, 0, w);

  P.add('shoulderL', -3, 3, -12, w);
  P.add('armL', 18, 5, -5, w);
  P.add('forearmL', -10, -3, 0, w);
}

/** Broken gun / missing shooting arm: lower the weapon and protect the torso. */
function disabledRangedAdd(P: Pose, missingRightArm: boolean, weight = 1): void {
  P.add('chest', 5, 0, missingRightArm ? -5 : 3, weight);
  P.add('spine', -2, 0, missingRightArm ? 4 : -2, weight);

  if (!missingRightArm) {
    // The ruined gun stays attached and sparks, but no longer snaps into ADS.
    P.add('shoulderR', 3, -4, 13, weight);
    P.add('armR', -5, -3, 5, weight);
    P.add('forearmR', 18, 4, 0, weight);
  }

  P.add('shoulderL', -4, 6, -15, weight);
  P.add('armL', 24, 10, -7, weight);
  P.add('forearmL', -30, -8, 0, weight);
}

/** Persistent posture changes driven by EnemyParts state stored on the actor root. */
function injuryAdd(P: Pose, broken: BrokenParts, phase: number, normalisedSpeed: number): void {
  if (broken.head) {
    P.add('neck', 5, -2, 7, 1);
    P.add('head', -7, Math.sin(phase * Math.PI * 4) * 2.2, -9, 1);
    P.add('chest', 2.5, 0, -2, 1);
  }

  if (broken.armL && !broken.armR) {
    // One-handed weapon use: shift weight toward the intact right side.
    P.add('spine', -1, 0, 4, 1);
    P.add('chest', 2, -1, 4, 1);
    P.add('shoulderR', -2, -3, 4, 1);
  } else if (broken.armR && !broken.armL) {
    // Missing shooting arm: the remaining hand instinctively guards the wound.
    P.add('spine', -3, 0, -6, 1);
    P.add('chest', 4, 0, -7, 1);
    P.add('shoulderL', -5, 8, -18, 1);
    P.add('armL', 28, 12, -9, 1);
    P.add('forearmL', -34, -8, 0, 1);
  } else if (broken.armL && broken.armR) {
    P.add('spine', -5, 0, 0, 1);
    P.add('chest', 8, 0, 0, 1);
  }

  const legL = Boolean(broken.legL);
  const legR = Boolean(broken.legR);
  const moving = THREE.MathUtils.clamp(normalisedSpeed * 1.7, 0, 1);
  const cycle = Math.sin(phase * Math.PI * 2);

  if (legL !== legR) {
    const side = legL ? -1 : 1;
    // A pronounced hip drop plus compensation in spine/chest makes the speed
    // penalty readable as a limp instead of simply looking like slow playback.
    P.hipRoll += side * (4 + Math.abs(cycle) * 4.5 * moving);
    P.hipPitch += 2.5 * moving;
    P.add('spine', -3, 0, -side * 5.5, 1);
    P.add('chest', 2, 0, -side * 2.5, 1);

    const supportThigh: BoneName = legL ? 'thighR' : 'thighL';
    const supportShin: BoneName = legL ? 'shinR' : 'shinL';
    P.add(supportThigh, -4 + cycle * 5, 0, -side * 2, moving);
    P.add(supportShin, 7 + Math.max(0, -cycle) * 9, 0, 0, moving);
  } else if (legL && legR) {
    // Both legs gone: the enemy can still drag itself at the heavily reduced
    // gameplay speed, but the torso stays low and pitches forward instead of
    // gliding upright through the world.
    P.hipPitch += 12;
    P.hipRoll += Math.sin(phase * Math.PI * 2) * 3 * moving;
    P.add('spine', -10, 0, 0, 1);
    P.add('chest', 8, 0, 0, 1);
    crouchAdd(P, 0.65);
  }
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

    // EnemyParts stores its persistent state on Enemy.group, the direct parent
    // of skeleton.root. Imported rigs can also put it on the skeleton root itself.
    const broken = this.brokenParts();
    const rangedDisabled = Boolean(broken.armR || broken.weapon);

    // --- additive combat layers --------------------------------------------
    this.aimWeight += ((context.aiming ? 1 : 0) - this.aimWeight) * (1 - Math.exp(-dt * 12));

    // Raider/heavy/sniper weapons used to hang from the right hand because the
    // default rig only raised the arms while actively shooting. Keep a two-hand
    // carry pose alive for every ordinary ranged enemy, unless EnemyParts has
    // removed the shooting arm or disabled the gun.
    if (!context.melee && !context.boss) {
      const carryWeight = 1 - this.aimWeight * 0.55;
      const combatReady = context.state === 'alert' || context.state === 'chase' ||
        context.state === 'attack' || context.state === 'retreat';
      if (rangedDisabled) disabledRangedAdd(layer, Boolean(broken.armR), 1);
      else rangedCarryAdd(layer, carryWeight, combatReady);
    }

    if (this.aimWeight > .001 && !rangedDisabled) aimAdd(layer, .9 * this.aimWeight);
    if (context.braced && !rangedDisabled) braceAdd(layer, 1);
    if (context.crouched) crouchAdd(layer, 1);
    if (context.state === 'patrol') patrolAdd(layer, this.phase, 1);
    if (context.state === 'retreat') retreatAdd(layer, this.phase, 1);
    if (context.alerted >= 0) alertAdd(layer, context.alerted, 1);

    if (context.melee && context.swing >= 0) {
      swingAdd(layer, THREE.MathUtils.clamp(context.swing, 0, 1), 1);
    } else if (context.sinceShot >= 0 && !rangedDisabled) {
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

    injuryAdd(layer, broken, this.phase, normalised);

    this.applyBlended(base, layer);
    this.applyRoot(base);
  }

  private brokenParts(): BrokenParts {
    const local = this.skeleton.root.userData.enemyBrokenParts as BrokenParts | undefined;
    const parent = this.skeleton.root.parent?.userData.enemyBrokenParts as BrokenParts | undefined;
    return parent ?? local ?? NO_BROKEN_PARTS;
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
