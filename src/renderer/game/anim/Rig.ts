import * as THREE from 'three';

/**
 * Segmented humanoid skeleton used by enemies.
 *
 * Bones are plain Object3D pivots; rigid low-poly shells are parented to them.
 * The convention (adapted from the MIT-licensed Claude-of-Duty rig, see NOTICE)
 * is what makes authored animation readable as anatomy rather than quaternion
 * soup:
 *
 *   local +Y runs down a limb toward its child
 *   rotation.x  flexion   (positive swings the limb forward; model faces -Z)
 *   rotation.y  twist     (roll about the limb's own length)
 *   rotation.z  lateral   (positive tips toward the entity's left)
 *
 * Each bone stores its bind-pose euler so animation can be authored as additive
 * deltas in degrees on top of a rest stance.
 */

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'armL'
  | 'forearmL'
  | 'shoulderR'
  | 'armR'
  | 'forearmR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR';

export const BONE_NAMES: BoneName[] = [
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
];

const BONE_INDEX = new Map<string, number>(BONE_NAMES.map((name, i) => [name, i]));

export class Skeleton {
  /** Placed at the feet; the whole hierarchy hangs off `hips`. */
  readonly root = new THREE.Group();
  readonly bones = new Map<BoneName, THREE.Object3D>();
  /** Bind-pose euler per bone in radians, indexed like BONE_NAMES. */
  readonly bind = new Float32Array(BONE_NAMES.length * 3);

  constructor(name: string) {
    this.root.name = name;
  }

  bone(name: BoneName, parent: THREE.Object3D | null, x: number, y: number, z: number): THREE.Object3D {
    const node = new THREE.Object3D();
    node.name = name;
    node.position.set(x, y, z);
    (parent ?? this.root).add(node);
    this.bones.set(name, node);
    return node;
  }

  /** Records the rest orientation of a bone (degrees). */
  setBind(name: BoneName, xDeg = 0, yDeg = 0, zDeg = 0): void {
    const node = this.bones.get(name);
    if (!node) return;
    node.rotation.set(THREE.MathUtils.degToRad(xDeg), THREE.MathUtils.degToRad(yDeg), THREE.MathUtils.degToRad(zDeg));
    const i = (BONE_INDEX.get(name) ?? 0) * 3;
    this.bind[i] = node.rotation.x;
    this.bind[i + 1] = node.rotation.y;
    this.bind[i + 2] = node.rotation.z;
  }

  /** Writes the bind euler of a bone (radians) into the components of `out`. */
  bindInto(name: BoneName, out: { x: number; y: number; z: number }): void {
    const i = (BONE_INDEX.get(name) ?? 0) * 3;
    out.x = this.bind[i];
    out.y = this.bind[i + 1];
    out.z = this.bind[i + 2];
  }

  reset(): void {
    for (const name of BONE_NAMES) {
      const node = this.bones.get(name);
      if (node) this.bindInto(name, node.rotation);
    }
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.bones.clear();
  }
}

/**
 * A pose is additive euler deltas in degrees plus a root offset. Poses are
 * plain data so locomotion and additive layers can be summed cheaply.
 */
export class Pose {
  readonly euler = new Float32Array(BONE_NAMES.length * 3);
  hipY = 0;
  hipPitch = 0;
  hipRoll = 0;
  hipYaw = 0;

  reset(): void {
    this.euler.fill(0);
    this.hipY = 0;
    this.hipPitch = 0;
    this.hipRoll = 0;
    this.hipYaw = 0;
  }

  /** Adds a delta in degrees, optionally scaled by a layer weight. */
  add(bone: BoneName, xDeg: number, yDeg: number, zDeg: number, weight = 1): void {
    if (weight === 0) return;
    const index = BONE_INDEX.get(bone);
    if (index === undefined) return;
    const i = index * 3;
    this.euler[i] += xDeg * weight;
    this.euler[i + 1] += yDeg * weight;
    this.euler[i + 2] += zDeg * weight;
  }

  /** Copies the delta for a bone (degrees) into `out`. */
  get(bone: BoneName, out: THREE.Vector3): THREE.Vector3 {
    const i = (BONE_INDEX.get(bone) ?? 0) * 3;
    return out.set(this.euler[i], this.euler[i + 1], this.euler[i + 2]);
  }
}
