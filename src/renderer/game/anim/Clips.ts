import type { Pose } from './Rig';

/**
 * Animation content for enemy rigs.
 *
 * Poses are authored as *local euler deltas in degrees* on top of the bind
 * stance (convention from the MIT-licensed Claude-of-Duty rig, see NOTICE):
 *
 *   x  flexion  — negative swings a limb forward (models face -Z)
 *   y  twist    — roll along the limb
 *   z  lateral  — positive tips toward the entity's left
 *
 * Because a clip is just a function writing deltas, locomotion and one-shot
 * layers can be summed numerically instead of needing an animation system.
 */

const TAU = Math.PI * 2;
const sin = Math.sin;
const cos = Math.cos;

/** One-sided lobe used for knee/ankle curves (flexion only happens on one side). */
const lobe = (x: number, k = 1.4): number => {
  const s = sin(x);
  return s > 0 ? s ** k : 0;
};

/** Stride amplitude for a gait: 0 at standstill, 1 at full run. */
export interface GaitParams {
  thigh: number;
  thighBias: number;
  thighTwist: number;
  splay: number;
  kneeBase: number;
  knee: number;
  kneeStance: number;
  ankle: number;
  ankleBias: number;
  sway: number;
  bob: number;
  bobBias: number;
  pelvisYaw: number;
  pelvisRoll: number;
  lean: number;
  spineYaw: number;
  armSwing: number;
  cycle: number;
}

export const WALK: GaitParams = {
  thigh: 21, thighBias: -2, thighTwist: 1.5, splay: 1.5,
  kneeBase: 7, knee: 44, kneeStance: 8,
  ankle: 11, ankleBias: 2,
  sway: 0.014, bob: 0.014, bobBias: -0.012,
  pelvisYaw: 4.5, pelvisRoll: 3.2,
  lean: 4, spineYaw: 3.4, armSwing: 3.5,
  cycle: 1.0,
};

export const RUN: GaitParams = {
  thigh: 36, thighBias: 3, thighTwist: 2, splay: 2,
  kneeBase: 15, knee: 88, kneeStance: 22,
  ankle: 19, ankleBias: 4,
  sway: 0.021, bob: 0.032, bobBias: -0.028,
  pelvisYaw: 7, pelvisRoll: 5,
  lean: 14, spineYaw: 6, armSwing: 7.5,
  cycle: 1.45,
};

/**
 * A two-beat walk/run cycle. `ph` is the normalised cycle phase, driven by real
 * ground speed so the feet do not skate.
 */
export function gait(P: Pose, ph: number, k: GaitParams, weight = 1): void {
  const t = ph * TAU;
  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'L' : 'R';
    // Left leg starts at contact, right leg half a cycle out of phase.
    const a = t + (side < 0 ? 0 : Math.PI);
    const thigh = -k.thigh * sin(a) + k.thighBias;
    // Knee flexes hard just after toe-off, barely during stance.
    const knee = k.kneeBase + k.knee * lobe(a - 0.55, 1.5) + k.kneeStance * lobe(a + Math.PI + 0.4, 2);
    const ankle = -k.ankle * sin(a - 1.9) + k.ankleBias;
    P.add(`thigh${tag}`, thigh, side * k.thighTwist, side * k.splay, weight);
    P.add(`shin${tag}`, knee, 0, 0, weight);
    P.add(`foot${tag}`, ankle, 0, 0, weight);
  }
  // Pelvis: two bobs per stride, roll toward the stance leg, counter-yaw.
  P.hipY += k.bobBias * weight + k.bob * cos(2 * t) * weight;
  P.hipYaw += k.pelvisYaw * sin(t) * weight;
  P.hipRoll += k.pelvisRoll * sin(t + 1.2) * weight;
  P.add('hips', -k.lean * 0.2, k.pelvisYaw * 0.6 * sin(t), k.pelvisRoll * 0.5 * sin(t + 1.2), weight);
  P.add('spine', k.lean * 0.35, -k.spineYaw * 0.45 * sin(t), -k.pelvisRoll * 0.35 * sin(t + 1.2), weight);
  P.add('chest', k.lean * 0.3, -k.spineYaw * sin(t), 0, weight);
  P.add('neck', -k.lean * 0.45, k.spineYaw * 0.6 * sin(t), 0, weight);
  // Shoulders carry the bounce so the weapon rides with the body.
  P.add('shoulderL', -k.armSwing * sin(t) - 1, 0, -1.5, weight);
  P.add('shoulderR', k.armSwing * sin(t) - 1, 0, 1.5, weight);
}

export const IDLE_VARIANTS = ['relaxed', 'lookout', 'weightShift', 'gearCheck'] as const;
export type IdleVariant = typeof IDLE_VARIANTS[number];

/** Continuous time, independent of footsteps. Gestures fade out before combat.
 * Upper arms stay near the ribs; all poses preserve the planted leg chain. */
export function idle(P: Pose, seconds: number, weight = 1, variant: IdleVariant = 'relaxed', gestures = 1): void {
  const breath = sin(seconds * 1.65);
  const sway = sin(seconds * .67 + 1.1);
  P.add('spine', .5 + .55 * breath, -.7 * sway, 0, weight);
  P.add('chest', .5 + .65 * breath, .5 * sway, 0, weight);
  P.add('neck', -.4 * breath, .7 * sway, 0, weight);
  P.add('shoulderL', -.35 * breath, 0, 0, weight);
  P.add('shoulderR', .35 * breath, 0, 0, weight);
  const w = weight * gestures;
  // Low carry, elbows bent and asymmetric rather than a rigid spread stance.
  P.add('armL', 8 + .7 * breath, 0, 1, w);
  P.add('armR', 12 + .6 * breath, 0, -1, w);
  P.add('forearmL', -9, 0, 0, w);
  P.add('forearmR', -12, 0, 0, w);
  if (variant === 'lookout') {
    const scan = sin(seconds * .48);
    P.add('chest', 0, 3 * scan, 0, w);
    P.add('neck', 0, 8 * scan, 0, w);
    P.add('head', -2 + sin(seconds * .7), 14 * scan, 0, w);
    P.add('forearmL', -8, 0, 0, w);
  } else if (variant === 'weightShift') {
    // Counter-lean above the hips: no root bob that lifts the feet off the floor.
    P.add('spine', 1, 2 * sway, 2.5 * sway, w);
    P.add('chest', -1, -2 * sway, -1.5 * sway, w);
    P.add('head', 0, -3 * sway, -.8 * sway, w);
    P.add('armL', -5, 0, 2 * sway, w);
    P.add('armR', 3, 0, 2 * sway, w);
  } else if (variant === 'gearCheck') {
    const check = (.5 + .5 * sin(seconds * .8)) ** 2;
    P.add('head', 12 * check, -9 * check, 0, w);
    P.add('neck', 3 * check, 0, 0, w);
    P.add('armL', 24 * check, -8 * check, 0, w);
    P.add('forearmL', -22 * check, 0, 0, w);
    P.add('chest', 2 * check, -3 * check, 0, w);
  } else {
    P.add('head', sin(seconds * .6), 2 * sway, .6 * sway, w);
    P.add('forearmL', 2 * sway, 0, 0, w);
  }
}

/** Aiming layer: shoulders square up, support arm comes under the stock. */
export function aimAdd(P: Pose, weight = 1): void {
  P.add('chest', 2.5, 0, 0, weight);
  P.add('neck', -2, 0, 0, weight);
  P.add('shoulderR', -4, 0, 3, weight);
  P.add('armR', 42, 0, 0, weight);
  P.add('forearmR', -36, 0, 0, weight);
  P.add('shoulderL', -3, 0, -6, weight);
  P.add('armL', 50, 0, 2, weight);
  P.add('forearmL', -44, 0, 0, weight);
}

/** Recoil impulse: chest absorbs, muzzle lifts, hips dip. `t` runs 0→1. */
export function fireAdd(P: Pose, t: number, strength = 1): void {
  const kick = (1 - t) ** 2 * strength;
  P.add('chest', -7 * kick, 0, 0);
  P.add('spine', -3 * kick, 0, 0);
  P.add('neck', 4 * kick, 0, 0);
  P.add('head', 5 * kick, 0, 0);
  P.add('shoulderR', 9 * kick, 0, 2 * kick);
  P.add('armR', 12 * kick, 0, 0);
  P.add('forearmR', 6 * kick, 0, 0);
  P.add('hips', 2 * kick, 0, 0);
  P.hipY -= 0.01 * kick;
}

/** Two-handed weapon raise while an attack winds up. `t` runs 0→1. */
export function windupAdd(P: Pose, t: number, weight = 1): void {
  const s = sin(t * Math.PI);
  P.add('chest', -4 * s, 4 * s, 0, weight);
  P.add('shoulderR', -10 * s, 0, 6 * s, weight);
  P.add('armR', -18 * s, 0, 6 * s, weight);
  P.add('forearmR', -26 * s, 0, 0, weight);
  P.add('shoulderL', -8 * s, 0, -8 * s, weight);
  P.add('armL', -16 * s, 0, -6 * s, weight);
  P.add('forearmL', -20 * s, 0, 0, weight);
}

/** Melee swing: overhead chop with a follow-through. `t` runs 0→1. */
export function swingAdd(P: Pose, t: number, weight = 1): void {
  // Wind up (0-0.35), strike (0.35-0.6), recover (0.6-1).
  const wind = Math.max(0, 1 - t / 0.35);
  const strike = t > 0.3 ? Math.min(1, (t - 0.3) / 0.22) : 0;
  const recover = t > 0.6 ? (t - 0.6) / 0.4 : 0;
  P.add('chest', -14 * wind + 20 * strike - 6 * recover, 6 * wind, 0, weight);
  P.add('shoulderR', -55 * wind + 40 * strike, 0, 10 * wind, weight);
  P.add('armR', -70 * wind + 55 * strike, 0, 6 * wind, weight);
  P.add('forearmR', -40 * wind + 25 * strike, 0, 0, weight);
  P.add('shoulderL', -18 * wind + 10 * strike, 0, -10 * wind, weight);
  P.add('armL', -26 * wind + 16 * strike, 0, -6 * wind, weight);
  P.add('forearmL', -30 * wind + 18 * strike, 0, 0, weight);
  P.add('neck', 8 * strike, 0, 0, weight);
  P.hipY -= 0.02 * strike;
}

/** Bracing layer for the heavy: wide stance, gun tucked. */
export function braceAdd(P: Pose, weight = 1): void {
  P.add('thighL', -8, 0, 6, weight);
  P.add('thighR', -8, 0, -6, weight);
  P.add('shinL', 12, 0, 0, weight);
  P.add('shinR', 12, 0, 0, weight);
  P.add('chest', 3, 0, 0, weight);
  P.hipY -= 0.03 * weight;
}

/** Prone-ish crouch used by the sniper when settled on a firing position. */
export function crouchAdd(P: Pose, weight = 1): void {
  P.add('thighL', -38, 0, 5, weight);
  P.add('thighR', -34, 0, -5, weight);
  P.add('shinL', 74, 0, 0, weight);
  P.add('shinR', 78, 0, 0, weight);
  P.add('footL', -30, 0, 0, weight);
  P.add('footR', -32, 0, 0, weight);
  P.add('chest', 8, 0, 0, weight);
  P.add('neck', -6, 0, 0, weight);
  P.hipY -= 0.34 * weight;
}

/** Hit reaction. `region` 0 = body, 1 = head. `t` runs 0→1. */
export function hitAdd(P: Pose, region: 0 | 1, t: number, side = 0, strength = 1): void {
  const kick = (1 - t) ** 1.6 * strength;
  const headKick = region === 1 ? 1.8 : 1;
  P.add('chest', 9 * kick * headKick, 0, side * 5 * kick);
  P.add('spine', 5 * kick * headKick, 0, side * 3 * kick);
  P.add('neck', 8 * kick * headKick, 0, side * 6 * kick);
  P.add('head', 11 * kick * headKick, side * 7 * kick * headKick, side * 4 * kick);
  P.add('shoulderL', 6 * kick, 0, -6 * kick);
  P.add('shoulderR', 6 * kick, 0, 6 * kick);
  P.add('armL', 10 * kick, 0, -4 * kick);
  P.add('armR', 10 * kick, 0, 4 * kick);
  P.hipY -= 0.02 * kick;
  P.hipPitch += 4 * kick;
}

/** Stagger while backing off (retreat state). */
export function retreatAdd(P: Pose, ph: number, weight = 1): void {
  const t = ph * TAU;
  P.add('chest', -6, 0, 0, weight);
  P.add('neck', 4, 0, 0, weight);
  P.add('shoulderL', -6 * sin(t), 0, -4, weight);
  P.add('shoulderR', 6 * sin(t), 0, 4, weight);
  P.hipPitch -= 3 * weight;
}

/**
 * Death falloff written as deltas against the bind stance: buckled knees,
 * torso folding, then the whole body lies flat. `t` runs 0→1 and holds.
 * `back` reverses the direction of the fall.
 */
export function deathFall(P: Pose, t: number, back = false): void {
  const e = t * t * (3 - 2 * t); // smoothstep
  const dir = back ? -1 : 1;
  // Legs give out first.
  P.add('thighL', -50 * e, 0, 4 * e);
  P.add('thighR', -34 * e, 0, -6 * e);
  P.add('shinL', 70 * e, 0, 0);
  P.add('shinR', 96 * e, 0, 0);
  P.add('footL', -26 * e, 0, 0);
  P.add('footR', -34 * e, 0, 0);
  // Torso crumples forward and rolls.
  P.add('spine', 16 * e, 4 * e, 6 * e);
  P.add('chest', 18 * e, -3 * e, 4 * e);
  P.add('neck', -22 * e, 8 * e, 0);
  P.add('head', -14 * e, -12 * e, 6 * e);
  // Arms go limp and splay.
  P.add('shoulderL', 22 * e, 0, -26 * e);
  P.add('shoulderR', 26 * e, 0, 30 * e);
  P.add('armL', 30 * e, 0, -18 * e);
  P.add('armR', 34 * e, 0, 22 * e);
  P.add('forearmL', 40 * e, 0, 0);
  P.add('forearmR', 46 * e, 0, 0);
  // The hips drop, and the body tips over past the point where bones alone
  // would carry it — the root does the rest of the fall.
  P.hipY -= 0.42 * e;
  P.hipPitch += dir * 78 * e;
  P.hipRoll += 14 * e;
}

/** Boss death: slow collapse with hydraulic sag, knees then back. */
export function bossDeath(P: Pose, t: number): void {
  const e = t * t * (3 - 2 * t);
  const sag = sin(Math.min(1, t * 1.15) * Math.PI * 0.5);
  P.add('thighL', -30 * sag, 0, 8 * sag);
  P.add('thighR', -36 * sag, 0, -8 * sag);
  P.add('shinL', 55 * sag, 0, 0);
  P.add('shinR', 62 * sag, 0, 0);
  P.add('spine', 10 * e, 3 * e, 0);
  P.add('chest', 14 * e, -4 * e, 0);
  P.add('neck', 26 * e, 6 * e, 0);
  P.add('head', 18 * e, 10 * e, 0);
  P.add('shoulderL', 20 * e, 0, -20 * e);
  P.add('shoulderR', 16 * e, 0, 24 * e);
  P.add('armL', 30 * e, 0, -14 * e);
  P.add('armR', 26 * e, 0, 18 * e);
  P.hipY -= 1.05 * e;
  P.hipPitch += 26 * e;
  P.hipRoll += 8 * e;
}

/** Getting up from idle into an alerted, weapon-raised posture. */
export function alertAdd(P: Pose, t: number, weight = 1): void {
  const s = sin(t * Math.PI) * 0.6 + t * 0.4;
  P.add('chest', -5 * s, 0, 0, weight);
  P.add('neck', -4 * s, 0, 0, weight);
  P.add('shoulderL', -8 * s, 0, -5 * s, weight);
  P.add('shoulderR', -10 * s, 0, 5 * s, weight);
  P.add('armR', -20 * s, 0, 4 * s, weight);
  P.add('forearmR', -26 * s, 0, 0, weight);
  P.hipY -= 0.02 * s * weight;
}

/** Strutting patrol sway for units with no target (kept subtle). */
export function patrolAdd(P: Pose, ph: number, weight = 1): void {
  const t = ph * TAU;
  P.add('neck', 0, 7 * sin(t * 0.5), 0, weight);
  P.add('head', 0, 10 * sin(t * 0.5 + 0.4), 0, weight);
  P.add('chest', 0, 4 * sin(t * 0.5 - 0.3), 0, weight);
}

/** Cycles per second multiplier for a gait at the given normalised speed. */
export function strideRate(speed: number, moveSpeed: number, cycle: number): number {
  const normalised = Math.min(1.6, speed / Math.max(0.001, moveSpeed));
  return (0.75 + normalised * 1.15) * cycle;
}
