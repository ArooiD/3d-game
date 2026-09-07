import * as THREE from 'three';

/**
 * Anything a weapon can hit. Enemies, the boss and (later) props implement this,
 * so the combat code never has to know about the enemy class. Registry lookups
 * are radius-filtered through a coarse grid so a shot only tests nearby bodies.
 */

export interface DamageOptions {
  headshot: boolean;
  critical: boolean;
  /** Extra fraction of damage applied to shields. */
  shieldBonus: number;
  direction: THREE.Vector3;
  fromPlayer: boolean;
  explosion?: boolean;
}

export interface TargetRegistry {
  readonly id: string;
  readonly position: THREE.Vector3;
  readonly root: THREE.Object3D;
  readonly alive: boolean;
  readonly hostile: boolean;
  readonly isBoss: boolean;
  readonly radius: number;
  readonly height: number;
  /** Feet y and head y used by the capsule test. */
  applyDamage(amount: number, options: DamageOptions): void;
  rayHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): { distance: number; headshot: boolean } | null;
  distanceTo(point: THREE.Vector3): number;
  /** Centre of mass for splash checks (mid-body). */
  readonly centre: THREE.Vector3;
}

const GRID = 12;

export class TargetGrid {
  private cells = new Map<string, TargetRegistry[]>();
  private all = new Set<TargetRegistry>();
  private dirty = true;

  register(target: TargetRegistry): void {
    this.all.add(target);
    this.dirty = true;
  }

  unregister(target: TargetRegistry): void {
    this.all.delete(target);
    this.dirty = true;
  }

  clear(): void {
    this.all.clear();
    this.dirty = true;
    this.cells.clear();
  }

  get size(): number {
    return this.all.size;
  }

  get entries(): TargetRegistry[] {
    return [...this.all];
  }

  /** Rebuild the grid for this frame (positions change constantly). */
  rebuild(): void {
    this.cells.clear();
    this.dirty = false;
    for (const target of this.all) {
      if (!target.alive) continue;
      const c = target.centre;
      for (const key of this.cellKeys(c, target.radius)) {
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(target);
        else this.cells.set(key, [target]);
      }
    }
  }

  private cellKeys(origin: THREE.Vector3, radius: number): string[] {
    const keys: string[] = [];
    const minX = Math.floor((origin.x - radius) / GRID);
    const maxX = Math.floor((origin.x + radius) / GRID);
    const minZ = Math.floor((origin.z - radius) / GRID);
    const maxZ = Math.floor((origin.z + radius) / GRID);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) keys.push(`${x},${z}`);
    }
    return keys;
  }

  querySphere(center: THREE.Vector3, radius: number, hostileOnly = false): TargetRegistry[] {
    if (this.dirty) this.rebuild();
    const out: TargetRegistry[] = [];
    const seen = new Set<TargetRegistry>();
    for (const key of this.cellKeys(center, radius)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      for (const target of bucket) {
        if (!target.alive || seen.has(target)) continue;
        seen.add(target);
        if (hostileOnly && !target.hostile) continue;
        if (target.distanceTo(center) <= radius + target.radius) out.push(target);
      }
    }
    return out;
  }

  /** Targets whose bounding cylinder is within `maxDistance` along the ray. */
  queryRay(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): TargetRegistry[] {
    if (this.dirty) this.rebuild();
    const out: TargetRegistry[] = [];
    const seen = new Set<string>();
    // Sample the ray so we touch every grid cell it passes through.
    const steps = Math.min(64, Math.max(4, Math.ceil(maxDistance / (GRID * 0.5))));
    const probe = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      probe.copy(origin).addScaledVector(dir, (i / steps) * maxDistance);
      for (const key of this.cellKeys(probe, 2)) {
        const bucket = this.cells.get(key);
        if (!bucket) continue;
        for (const target of bucket) {
          if (!target.alive || !target.hostile || seen.has(target.id)) continue;
          seen.add(target.id);
          out.push(target);
        }
      }
    }
    return out;
  }

  sphereHit(center: THREE.Vector3, radius: number, fromPlayer: boolean): TargetRegistry | null {
    const candidates = this.querySphere(center, radius, fromPlayer);
    let best: TargetRegistry | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const target of candidates) {
      const d = target.distanceTo(center);
      if (d < bestDistance) {
        bestDistance = d;
        best = target;
      }
    }
    return best;
  }

  nearest(point: THREE.Vector3, maxDistance: number, hostileOnly = true): TargetRegistry | null {
    const candidates = this.querySphere(point, maxDistance, hostileOnly);
    let best: TargetRegistry | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const target of candidates) {
      const d = target.distanceTo(point);
      if (d < bestDistance) {
        bestDistance = d;
        best = target;
      }
    }
    return best;
  }
}

/** Finite vertical cylinder ray test; the upper region counts as a headshot. */
export function rayCylinder(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  feetY: number,
  headY: number,
  maxDistance: number,
): { distance: number; headshot: boolean } | null {
  const ox = origin.x - center.x, oz = origin.z - center.z;
  const a = dir.x * dir.x + dir.z * dir.z;
  const c = ox * ox + oz * oz - radius * radius;
  let enter = 0, exit = maxDistance;
  if (a < 1e-12) {
    if (c > 0) return null;
  } else {
    const b = ox * dir.x + oz * dir.z;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    enter = Math.max(enter, (-b - root) / a);
    exit = Math.min(exit, (-b + root) / a);
  }
  if (Math.abs(dir.y) < 1e-12) {
    if (origin.y < feetY || origin.y > headY) return null;
  } else {
    const first = (feetY - origin.y) / dir.y;
    const second = (headY - origin.y) / dir.y;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (enter > exit || exit < 0) return null;
  return { distance: enter, headshot: origin.y + dir.y * enter >= headY - radius * 1.2 };
}
