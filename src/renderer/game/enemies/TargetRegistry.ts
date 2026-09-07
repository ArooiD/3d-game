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

  register(target: TargetRegistry): void {
    this.all.add(target);
  }

  unregister(target: TargetRegistry): void {
    this.all.delete(target);
  }

  clear(): void {
    this.all.clear();
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
    for (const target of this.all) {
      if (!target.alive) continue;
      const c = target.centre;
      const key = `${Math.floor(c.x / GRID)},${Math.floor(c.z / GRID)}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(target);
      else this.cells.set(key, [target]);
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
    this.rebuild();
    const out: TargetRegistry[] = [];
    for (const key of this.cellKeys(center, radius)) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      for (const target of bucket) {
        if (hostileOnly && !target.hostile) continue;
        if (target.distanceTo(center) <= radius + target.radius) out.push(target);
      }
    }
    return out;
  }

  /** Targets whose bounding cylinder is within `maxDistance` along the ray. */
  queryRay(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number): TargetRegistry[] {
    this.rebuild();
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
          if (!target.hostile || seen.has(target.id)) continue;
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

/** Capsule (cylinder + head sphere) ray test shared by all targets. */
export function rayCylinder(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  feetY: number,
  headY: number,
  maxDistance: number,
): { distance: number; headshot: boolean } | null {
  // Infinite cylinder around the vertical axis through center.
  const ox = origin.x - center.x;
  const oz = origin.z - center.z;
  const dx = dir.x;
  const dz = dir.z;
  const a = dx * dx + dz * dz;
  let tEnter = Number.POSITIVE_INFINITY;

  if (a > 1e-9) {
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = (-b - sq) / (2 * a);
    const t1 = (-b + sq) / (2 * a);
    if (t1 < 0) return null;
    tEnter = t0 >= 0 ? t0 : t1;
    if (tEnter > maxDistance) return null;
  } else if (ox * ox + oz * oz > radius * radius) {
    // Vertical ray that misses the cylinder entirely.
    return null;
  }

  const hitY = origin.y + dir.y * tEnter;
  const headRadius = radius * 0.62;
  const headCenterY = headY - headRadius;

  if (hitY >= feetY && hitY <= headCenterY - headRadius * 0.2) {
    return { distance: tEnter, headshot: false };
  }

  // Head sphere test (covers the top of the capsule and slightly above).
  const oy = origin.y - headCenterY;
  const dy = dir.y;
  const b2 = 2 * (ox * dx + oz * dz + oy * dy);
  const c2 = ox * ox + oz * oz + oy * oy - headRadius * headRadius;
  const disc2 = b2 * b2 - 4 * (dx * dx + dy * dy + dz * dz) * c2;
  if (disc2 >= 0) {
    const sq2 = Math.sqrt(disc2);
    const aa = dx * dx + dy * dy + dz * dz;
    const t0 = (-b2 - sq2) / (2 * aa);
    const t1 = (-b2 + sq2) / (2 * aa);
    const tHead = t0 >= 0 ? t0 : t1 >= 0 ? t1 : Number.POSITIVE_INFINITY;
    if (tHead <= maxDistance) return { distance: tHead, headshot: true };
  }

  if (hitY > headCenterY - headRadius * 0.2 && hitY <= headY && tEnter <= maxDistance) {
    return { distance: tEnter, headshot: true };
  }
  if (tEnter <= maxDistance && hitY >= feetY && hitY <= headY) {
    return { distance: tEnter, headshot: false };
  }
  return null;
}
