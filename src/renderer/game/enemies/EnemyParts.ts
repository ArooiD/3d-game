import * as THREE from 'three';
import type { TargetRegistry } from './TargetRegistry';

/** Anatomical / equipment slots understood by combat and future gore/armour UI. */
export type EnemyPartId =
  | 'head'
  | 'torso'
  | 'armL'
  | 'armR'
  | 'legL'
  | 'legR'
  | 'weapon';

export interface EnemyPartHit {
  part: EnemyPartId;
  distance: number;
  headshot: boolean;
}

export interface EnemyPartDamageResult {
  part: EnemyPartId;
  /** Damage after the anatomical multiplier, passed to the enemy health/shield API. */
  bodyDamage: number;
  /** Raw damage accumulated by this part's own integrity pool. */
  partDamage: number;
  multiplier: number;
  headshot: boolean;
  criticalPart: boolean;
  destroyed: boolean;
  integrity: number;
  maxIntegrity: number;
}

export interface EnemyPartSnapshot {
  id: EnemyPartId;
  integrity: number;
  maxIntegrity: number;
  ratio: number;
  destroyed: boolean;
  damageMultiplier: number;
}

interface PartConfig {
  damageMultiplier: number;
  integrityFraction: number;
  criticalPart: boolean;
  breakable: boolean;
  detachable: boolean;
}

interface PartState extends PartConfig {
  id: EnemyPartId;
  integrity: number;
  maxIntegrity: number;
  destroyed: boolean;
}

interface HitSphere {
  part: EnemyPartId;
  anchor: THREE.Object3D;
  offset: THREE.Vector3;
  radius: number;
}

const PART_CONFIG: Record<EnemyPartId, PartConfig> = {
  // Headshots are deliberately valuable but not an automatic kill. The normal
  // enemy health pool remains authoritative, while head integrity gives us a
  // separate hook for helmet break, concussion and later gore.
  head: { damageMultiplier: 1.6, integrityFraction: 0.28, criticalPart: true, breakable: true, detachable: false },
  torso: { damageMultiplier: 1.0, integrityFraction: 1.0, criticalPart: false, breakable: false, detachable: false },
  armL: { damageMultiplier: 0.82, integrityFraction: 0.34, criticalPart: false, breakable: true, detachable: true },
  armR: { damageMultiplier: 0.82, integrityFraction: 0.34, criticalPart: false, breakable: true, detachable: true },
  legL: { damageMultiplier: 0.9, integrityFraction: 0.42, criticalPart: false, breakable: true, detachable: true },
  legR: { damageMultiplier: 0.9, integrityFraction: 0.42, criticalPart: false, breakable: true, detachable: true },
  weapon: { damageMultiplier: 0.55, integrityFraction: 0.24, criticalPart: false, breakable: true, detachable: true },
};

/**
 * Per-enemy anatomical damage state.
 *
 * The system is intentionally independent of EnemyModels. It discovers the
 * standard rig bones from TargetRegistry.root and builds lightweight animated
 * hit spheres around them. That lets procedural models, imported GLTF enemies,
 * armour variants and future EnemyParts meshes share the same damage API.
 */
export class EnemyParts {
  private readonly states = new Map<EnemyPartId, PartState>();
  private readonly volumes: HitSphere[] = [];
  private readonly meshes = new Map<EnemyPartId, THREE.Mesh[]>();
  private readonly detachable: boolean;

  private readonly center = new THREE.Vector3();
  private readonly oc = new THREE.Vector3();

  constructor(private readonly target: TargetRegistry) {
    const maxHealth = readPositiveNumber(target, 'maxHealth') ?? 100;
    this.detachable = !target.isBoss;

    for (const id of Object.keys(PART_CONFIG) as EnemyPartId[]) {
      const config = PART_CONFIG[id];
      const maxIntegrity = Math.max(1, maxHealth * config.integrityFraction);
      this.states.set(id, {
        id,
        ...config,
        integrity: maxIntegrity,
        maxIntegrity,
        destroyed: false,
      });
      this.meshes.set(id, []);
    }

    this.discoverMeshes();
    this.buildHitVolumes();
  }

  /** Nearest animated anatomical hit, or null when the rig has no suitable bones. */
  rayHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): EnemyPartHit | null {
    this.target.root.updateWorldMatrix(true, true);
    let bestDistance = maxDistance;
    let bestPart: EnemyPartId | null = null;

    for (const volume of this.volumes) {
      const state = this.states.get(volume.part)!;
      // Once a limb has visibly gone, bullets should pass through the missing
      // geometry and continue into the torso/world behind it.
      if (state.destroyed && state.detachable && this.detachable) continue;

      this.center.copy(volume.offset).applyMatrix4(volume.anchor.matrixWorld);
      const distance = raySphere(origin, dir, this.center, volume.radius, bestDistance, this.oc);
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance;
        bestPart = volume.part;
      }
    }

    return bestPart
      ? { part: bestPart, distance: bestDistance, headshot: bestPart === 'head' }
      : null;
  }

  /**
   * Applies raw weapon damage to one part and returns the amount the regular
   * enemy health/shield system should receive. Breaking limbs also applies a
   * small persistent gameplay impairment through the target's public stats.
   */
  applyDamage(part: EnemyPartId | null | undefined, amount: number): EnemyPartDamageResult {
    const id = part ?? 'torso';
    const state = this.states.get(id) ?? this.states.get('torso')!;
    const safeAmount = Math.max(0, Number.isFinite(amount) ? amount : 0);
    const wasDestroyed = state.destroyed;

    if (state.breakable && !state.destroyed && safeAmount > 0) {
      state.integrity = Math.max(0, state.integrity - safeAmount);
      if (state.integrity <= 0) {
        state.destroyed = true;
        this.breakPart(state.id);
      }
    }

    // Already-destroyed non-detached critical parts stay vulnerable. A ruined
    // helmet/head therefore remains a useful precision target rather than
    // becoming an invisible invulnerable zone.
    const multiplier = state.damageMultiplier * (state.destroyed && !state.detachable ? 1.08 : 1);
    return {
      part: state.id,
      bodyDamage: safeAmount * multiplier,
      partDamage: safeAmount,
      multiplier,
      headshot: state.id === 'head',
      criticalPart: state.criticalPart,
      destroyed: !wasDestroyed && state.destroyed,
      integrity: state.integrity,
      maxIntegrity: state.maxIntegrity,
    };
  }

  snapshot(part: EnemyPartId): EnemyPartSnapshot {
    const state = this.states.get(part)!;
    return {
      id: state.id,
      integrity: state.integrity,
      maxIntegrity: state.maxIntegrity,
      ratio: state.integrity / Math.max(1, state.maxIntegrity),
      destroyed: state.destroyed,
      damageMultiplier: state.damageMultiplier,
    };
  }

  snapshots(): EnemyPartSnapshot[] {
    return [...this.states.keys()].map((id) => this.snapshot(id));
  }

  /** Future equipment builders can override automatic bone ancestry. */
  registerMesh(part: EnemyPartId, mesh: THREE.Mesh): void {
    mesh.userData.enemyPart = part;
    const list = this.meshes.get(part)!;
    if (!list.includes(mesh)) list.push(mesh);
  }

  private discoverMeshes(): void {
    this.target.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const explicit = object.userData.enemyPart as EnemyPartId | undefined;
      const part = explicit ?? inferPartFromAncestors(object);
      this.registerMesh(part, object);
    });
  }

  private buildHitVolumes(): void {
    const root = this.target.root;
    const height = this.target.height;
    const bodyRadius = this.target.radius;

    const head = root.getObjectByName('head');
    const chest = root.getObjectByName('chest');
    const spine = root.getObjectByName('spine');
    const hips = root.getObjectByName('hips');

    if (head) this.addSphere('head', head, 0, height * 0.055, -height * 0.004, Math.max(height * 0.078, bodyRadius * 0.34));
    if (chest) this.addSphere('torso', chest, 0, height * 0.025, 0, Math.max(height * 0.115, bodyRadius * 0.7));
    if (spine) this.addSphere('torso', spine, 0, height * 0.035, 0, Math.max(height * 0.105, bodyRadius * 0.66));
    if (hips) this.addSphere('torso', hips, 0, 0, 0, Math.max(height * 0.09, bodyRadius * 0.62));

    this.addArm('L', 'armL', height, bodyRadius);
    this.addArm('R', 'armR', height, bodyRadius);
    this.addLeg('L', 'legL', height, bodyRadius);
    this.addLeg('R', 'legR', height, bodyRadius);
  }

  private addArm(side: 'L' | 'R', part: 'armL' | 'armR', height: number, bodyRadius: number): void {
    const arm = this.target.root.getObjectByName(`arm${side}`);
    const forearm = this.target.root.getObjectByName(`forearm${side}`);
    if (!arm || !forearm) return;

    const upper = Math.max(height * 0.12, Math.abs(forearm.position.y));
    const radius = Math.max(height * 0.038, bodyRadius * 0.21);
    this.addSphere(part, arm, 0, -upper * 0.35, 0, radius * 1.08);
    this.addSphere(part, arm, 0, -upper * 0.78, 0, radius);
    this.addSphere(part, forearm, 0, -upper * 0.34, 0, radius * 0.94);
    this.addSphere(part, forearm, 0, -upper * 0.78, 0, radius * 0.82);
  }

  private addLeg(side: 'L' | 'R', part: 'legL' | 'legR', height: number, bodyRadius: number): void {
    const thigh = this.target.root.getObjectByName(`thigh${side}`);
    const shin = this.target.root.getObjectByName(`shin${side}`);
    const foot = this.target.root.getObjectByName(`foot${side}`);
    if (!thigh || !shin || !foot) return;

    const thighLength = Math.max(height * 0.18, Math.abs(shin.position.y));
    const shinLength = Math.max(height * 0.17, Math.abs(foot.position.y));
    const radius = Math.max(height * 0.047, bodyRadius * 0.25);
    this.addSphere(part, thigh, 0, -thighLength * 0.35, 0, radius * 1.08);
    this.addSphere(part, thigh, 0, -thighLength * 0.8, 0, radius);
    this.addSphere(part, shin, 0, -shinLength * 0.35, 0, radius * 0.92);
    this.addSphere(part, shin, 0, -shinLength * 0.82, -radius * 0.08, radius * 0.82);
  }

  private addSphere(part: EnemyPartId, anchor: THREE.Object3D, x: number, y: number, z: number, radius: number): void {
    this.volumes.push({ part, anchor, offset: new THREE.Vector3(x, y, z), radius });
  }

  private breakPart(part: EnemyPartId): void {
    const state = this.states.get(part)!;
    const actor = this.target as unknown as { moveSpeed?: number; damage?: number };

    // Functional damage is intentionally modest: the player gets readable
    // feedback without turning a single limb break into a soft-lock.
    if (part === 'legL' || part === 'legR') {
      if (typeof actor.moveSpeed === 'number') actor.moveSpeed *= this.target.isBoss ? 0.92 : 0.78;
    } else if (part === 'armR') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.9 : 0.72;
    } else if (part === 'armL') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.94 : 0.88;
    } else if (part === 'head') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.94 : 0.82;
    } else if (part === 'weapon') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.85 : 0.58;
    }

    if (!state.detachable || !this.detachable) return;
    for (const mesh of this.meshes.get(part) ?? []) {
      mesh.visible = false;
      mesh.userData.enemyPartBroken = true;
    }
  }
}

/** Lifecycle/cache wrapper owned by CombatSystem. */
export class EnemyPartsSystem {
  private instances = new WeakMap<TargetRegistry, EnemyParts>();

  for(target: TargetRegistry): EnemyParts {
    let parts = this.instances.get(target);
    if (!parts) {
      parts = new EnemyParts(target);
      this.instances.set(target, parts);
    }
    return parts;
  }

  rayHit(target: TargetRegistry, origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): EnemyPartHit | null {
    return this.for(target).rayHit(origin, dir, maxDistance);
  }

  applyDamage(target: TargetRegistry, part: EnemyPartId | null | undefined, amount: number): EnemyPartDamageResult {
    return this.for(target).applyDamage(part, amount);
  }

  snapshot(target: TargetRegistry, part: EnemyPartId): EnemyPartSnapshot {
    return this.for(target).snapshot(part);
  }

  clear(): void {
    this.instances = new WeakMap<TargetRegistry, EnemyParts>();
  }
}

function inferPartFromAncestors(object: THREE.Object3D): EnemyPartId {
  let node: THREE.Object3D | null = object;
  while (node) {
    const explicit = node.userData.enemyPart as EnemyPartId | undefined;
    if (explicit) return explicit;
    switch (node.name) {
      case 'head':
      case 'neck':
        return 'head';
      case 'shoulderL':
      case 'armL':
      case 'forearmL':
        return 'armL';
      case 'shoulderR':
      case 'armR':
      case 'forearmR':
        return 'armR';
      case 'thighL':
      case 'shinL':
      case 'footL':
        return 'legL';
      case 'thighR':
      case 'shinR':
      case 'footR':
        return 'legR';
      default:
        break;
    }
    node = node.parent;
  }
  return 'torso';
}

function raySphere(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  maxDistance: number,
  scratch: THREE.Vector3,
): number | null {
  scratch.copy(origin).sub(center);
  const b = scratch.dot(dir);
  const c = scratch.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  let distance = -b - root;
  if (distance < 0) distance = -b + root;
  if (distance < 0 || distance > maxDistance) return null;
  return distance;
}

function readPositiveNumber(object: unknown, key: string): number | null {
  const value = (object as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
