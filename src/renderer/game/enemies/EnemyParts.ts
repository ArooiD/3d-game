import * as THREE from 'three';
import { bus, GameEvents } from '../core/EventBus';
import type { TargetRegistry } from './TargetRegistry';

/** Anatomical / equipment slots understood by combat and visual damage. */
export type EnemyPartId =
  | 'head'
  | 'torso'
  | 'armL'
  | 'armR'
  | 'legL'
  | 'legR'
  | 'weapon';

export type EnemyBrokenPartFlags = Partial<Record<EnemyPartId, boolean>>;
export type EnemyPartVisualSeverity = 'damaged' | 'destroyed';

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
  damaged: boolean;
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
  damaged: boolean;
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
  // A destroyed gun remains attached so it can visibly spark instead of simply
  // vanishing. Losing the right arm still takes the gun with it because the gun
  // meshes are physically parented under forearmR.
  weapon: { damageMultiplier: 0.55, integrityFraction: 0.24, criticalPart: false, breakable: true, detachable: false },
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
        damaged: false,
        destroyed: false,
      });
      this.meshes.set(id, []);
    }

    // Animation deliberately reads this plain record through the rig parent. It
    // keeps EnemyAnimator independent of the combat system while still allowing
    // persistent one-arm / limp / damaged-weapon poses.
    if (!this.target.root.userData.enemyBrokenParts) {
      this.target.root.userData.enemyBrokenParts = {} as EnemyBrokenPartFlags;
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
   * enemy health/shield system should receive. At half integrity a part emits a
   * one-shot visual-damage event; zero integrity emits the destruction event.
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
        state.damaged = true;
        this.breakPart(state.id);
      } else if (!state.damaged && state.integrity <= state.maxIntegrity * 0.5) {
        state.damaged = true;
        this.emitVisual(state.id, 'damaged');
      }
    }

    // Already-destroyed non-detached critical parts stay vulnerable. A ruined
    // helmet/head or disabled gun therefore remains a readable precision target.
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
      damaged: state.damaged,
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
    this.addWeapon(height, bodyRadius);
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

  private addWeapon(height: number, bodyRadius: number): void {
    const behavior = (this.target as unknown as { definition?: { behavior?: string } }).definition?.behavior;
    if (behavior !== 'raider' && behavior !== 'heavy' && behavior !== 'sniper') return;

    const forearm = this.target.root.getObjectByName('forearmR');
    const muzzle = this.target.root.getObjectByName('muzzle');
    if (!forearm || !muzzle) return;

    // EnemyModels keeps the muzzle on forearmR. Reusing that authored endpoint
    // lets the weapon hit volumes automatically fit raider, heavy and sniper gun
    // lengths without duplicating those dimensions here.
    const y = muzzle.parent === forearm ? muzzle.position.y : -height * 0.17;
    const endZ = muzzle.parent === forearm ? muzzle.position.z : -height * 0.5;
    const radius = Math.max(height * 0.034, bodyRadius * 0.17);
    this.addSphere('weapon', forearm, 0, y, endZ * 0.3, radius * 1.15);
    this.addSphere('weapon', forearm, 0, y, endZ * 0.57, radius);
    this.addSphere('weapon', forearm, 0, y, endZ * 0.82, radius * 0.82);
  }

  private addSphere(part: EnemyPartId, anchor: THREE.Object3D, x: number, y: number, z: number, radius: number): void {
    this.volumes.push({ part, anchor, offset: new THREE.Vector3(x, y, z), radius });
  }

  private breakPart(part: EnemyPartId): void {
    const state = this.states.get(part)!;
    const actor = this.target as unknown as {
      moveSpeed?: number;
      damage?: number;
      definition?: { behavior?: string };
    };
    const flags = this.target.root.userData.enemyBrokenParts as EnemyBrokenPartFlags;
    flags[part] = true;

    // Functional damage makes the visual break matter in combat. A missing
    // shooting arm / ruined weapon is a much bigger impairment than losing the
    // support hand, while leg damage produces a clear limp without freezing AI.
    if (part === 'legL' || part === 'legR') {
      if (typeof actor.moveSpeed === 'number') {
        actor.moveSpeed *= this.target.isBoss ? 0.92 : 0.68;
        if (flags.legL && flags.legR && !this.target.isBoss) actor.moveSpeed *= 0.48;
      }
    } else if (part === 'armR') {
      if (typeof actor.damage === 'number') {
        actor.damage *= actor.definition?.behavior === 'rusher' ? 0.58 : this.target.isBoss ? 0.88 : 0.18;
      }
    } else if (part === 'armL') {
      if (typeof actor.damage === 'number') {
        actor.damage *= actor.definition?.behavior === 'rusher' ? 0.62 : this.target.isBoss ? 0.94 : 0.82;
      }
    } else if (part === 'head') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.94 : 0.8;
    } else if (part === 'weapon') {
      if (typeof actor.damage === 'number') actor.damage *= this.target.isBoss ? 0.82 : 0.28;
    }

    this.emitVisual(part, 'destroyed');

    if (!state.detachable || !this.detachable) return;
    for (const mesh of this.meshes.get(part) ?? []) {
      mesh.visible = false;
      mesh.userData.enemyPartBroken = true;
    }
  }

  private emitVisual(part: EnemyPartId, severity: EnemyPartVisualSeverity): void {
    // Emit before destruction hides meshes. EffectsSystem is synchronous and
    // clones the current animated world transforms into short-lived debris.
    this.target.root.updateWorldMatrix(true, true);
    const worldRoot = this.target.root.getWorldPosition(new THREE.Vector3());
    bus.emit(GameEvents.EnemyPartVisual, {
      id: this.target.id,
      part,
      severity,
      root: this.target.root,
      meshes: [...(this.meshes.get(part) ?? [])].filter((mesh) => mesh.visible),
      isBoss: this.target.isBoss,
      height: this.target.height,
      groundY: worldRoot.y,
    });
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
