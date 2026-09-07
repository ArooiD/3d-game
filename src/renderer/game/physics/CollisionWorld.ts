import * as THREE from 'three';

/**
 * Lightweight collision world purpose-built for this game:
 *
 *  - every collider is an axis-aligned box (walls, crates, rocks, terrain pads)
 *  - characters are vertical capsules approximated by a cylinder swept in X/Z
 *    plus a vertical step-up test, which is all an FPS controller needs
 *  - a uniform spatial hash keeps query cost flat across the 300x300 map
 *
 * A physics engine (cannon-es / rapier) would work too, but AABBs + a hash grid
 * give deterministic results, zero allocation per query and ~one tenth the code.
 */

export interface ColliderBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** Walkable top surface (equals maxY unless it is a decorative prop). */
  topY: number;
  /** Solid on top: standing is allowed. Ramps/decor may set false. */
  solid: boolean;
  tags: string[];
}

interface Cell {
  boxes: ColliderBox[];
}

const CELL_SIZE = 10;
const EPSILON = 1e-4;

export class CollisionWorld {
  private cells = new Map<string, Cell>();
  private boxes: ColliderBox[] = [];
  /** Height field of the terrain pads so the ground is not perfectly flat. */
  private heightSamples: { x: number; z: number; y: number; radius: number }[] = [];
  private groundY = 0;

  get count(): number {
    return this.boxes.length;
  }

  clear(): void {
    this.cells.clear();
    this.boxes.length = 0;
    this.heightSamples.length = 0;
  }

  setFlatGround(y: number): void {
    this.groundY = y;
  }

  getFlatGround(): number {
    return this.groundY;
  }

  /** Add a raised area the player can walk onto (plateaus, ramps, arena floor). */
  addHeightSample(x: number, z: number, y: number, radius: number): void {
    this.heightSamples.push({ x, z, y, radius });
  }

  addBox(
    center: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    options: { solid?: boolean; tags?: string[] } = {},
  ): ColliderBox {
    const box: ColliderBox = {
      minX: center.x - size.x / 2,
      maxX: center.x + size.x / 2,
      minY: center.y - size.y / 2,
      maxY: center.y + size.y / 2,
      minZ: center.z - size.z / 2,
      maxZ: center.z + size.z / 2,
      topY: center.y + size.y / 2,
      solid: options.solid ?? true,
      tags: options.tags ?? [],
    };
    this.insert(box);
    return box;
  }

  /** Register a box that is already expressed as min/max values. */
  addRawBox(box: ColliderBox): ColliderBox {
    this.insert(box);
    return box;
  }

  private insert(box: ColliderBox): void {
    this.boxes.push(box);
    const x0 = Math.floor(box.minX / CELL_SIZE);
    const x1 = Math.floor(box.maxX / CELL_SIZE);
    const z0 = Math.floor(box.minZ / CELL_SIZE);
    const z1 = Math.floor(box.maxZ / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = `${cx},${cz}`;
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { boxes: [] };
          this.cells.set(key, cell);
        }
        cell.boxes.push(box);
      }
    }
  }

  /** Ground height at a position, combining flat ground and height samples. */
  groundHeight(x: number, z: number): number {
    let y = this.groundY;
    for (const sample of this.heightSamples) {
      const dx = x - sample.x;
      const dz = z - sample.z;
      const distSq = dx * dx + dz * dz;
      const r = sample.radius;
      if (distSq > r * r) continue;
      const falloff = 1 - Math.sqrt(distSq) / r;
      const candidate = sample.y * Math.min(1, 0.35 + falloff);
      if (candidate > y) y = candidate;
    }
    return y;
  }

  /** Standing height: ground plus any solid box top under the point. */
  surfaceHeight(x: number, z: number, maxY = 40): number {
    let best = this.groundHeight(x, z);
    for (const box of this.queryArea(x, z, 0.001)) {
      if (!box.solid) continue;
      if (box.topY <= maxY + EPSILON && box.topY > best) best = box.topY;
    }
    return best;
  }

  queryArea(x: number, z: number, pad: number): ColliderBox[] {
    const out: ColliderBox[] = [];
    const x0 = Math.floor((x - pad) / CELL_SIZE);
    const x1 = Math.floor((x + pad) / CELL_SIZE);
    const z0 = Math.floor((z - pad) / CELL_SIZE);
    const z1 = Math.floor((z + pad) / CELL_SIZE);
    const seen = new Set<ColliderBox>();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.cells.get(`${cx},${cz}`);
        if (!cell) continue;
        for (const box of cell.boxes) {
          if (seen.has(box)) continue;
          seen.add(box);
          out.push(box);
        }
      }
    }
    return out;
  }

  /** Overlap test for a vertical cylinder (character body). */
  overlaps(x: number, y: number, z: number, radius: number, height: number): ColliderBox[] {
    const hits: ColliderBox[] = [];
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid) continue;
      if (x + radius <= box.minX || x - radius >= box.maxX) continue;
      if (z + radius <= box.minZ || z - radius >= box.maxZ) continue;
      // Vertical overlap: body spans [y, y + height].
      if (y + height <= box.minY + EPSILON || y >= box.maxY - EPSILON) continue;
      hits.push(box);
    }
    return hits;
  }

  /**
   * Resolve a horizontal move for a cylinder, sliding along box faces.
   * Returns the adjusted position. `maxStep` allows walking up small ledges.
   */
  moveCylinder(
    pos: { x: number; y: number; z: number },
    delta: { x: number; y: number; z: number },
    radius: number,
    height: number,
    maxStep: number,
  ): { x: number; y: number; z: number; hitWall: boolean; grounded: boolean } {
    let hitWall = false;

    // --- X axis ---
    let nx = pos.x + delta.x;
    if (delta.x !== 0) {
      const feet = this.standingY(pos.x, pos.y, pos.z, radius, height);
      const hits = this.overlaps(nx, feet + EPSILON, pos.z, radius, height);
      if (hits.length > 0) {
        hitWall = true;
        nx = delta.x > 0 ? Math.min(...hits.map((b) => b.minX)) - radius : Math.max(...hits.map((b) => b.maxX)) + radius;
      }
    }

    // --- Z axis ---
    let nz = pos.z + delta.z;
    if (delta.z !== 0) {
      const feet = this.standingY(nx, pos.y, pos.z, radius, height);
      const hits = this.overlaps(nx, feet + EPSILON, nz, radius, height);
      if (hits.length > 0) {
        hitWall = true;
        nz = delta.z > 0 ? Math.min(...hits.map((b) => b.minZ)) - radius : Math.max(...hits.map((b) => b.maxZ)) + radius;
      }
    }

    // --- Vertical: snap to the walkable surface ---
    const surface = this.surfaceHeight(nx, nz, pos.y + maxStep);
    let ny = pos.y + delta.y;
    let grounded = false;
    if (ny <= surface + EPSILON) {
      ny = surface;
      grounded = true;
    } else if (
      delta.y > 0 &&
      this.overlaps(nx, pos.y, nz, radius, height).length > 0
    ) {
      // Head bump.
      const hits = this.overlaps(nx, pos.y, nz, radius, height);
      const ceiling = Math.min(...hits.map((b) => b.minY));
      ny = Math.max(pos.y, ceiling - height);
    }

    // Never allow the body to end inside a solid box.
    const stuck = this.overlaps(nx, ny + EPSILON, nz, radius, height);
    if (stuck.length > 0) {
      const top = Math.max(...stuck.map((b) => b.topY));
      if (top - ny <= maxStep + 0.35) {
        ny = top;
        grounded = true;
      } else {
        // Push back out along the smaller penetration axis.
        const box = stuck[0] as ColliderBox;
        const pushLeft = Math.abs(nx - (box.minX - radius));
        const pushRight = Math.abs(nx - (box.maxX + radius));
        const pushBack = Math.abs(nz - (box.minZ - radius));
        const pushFwd = Math.abs(nz - (box.maxZ + radius));
        const minPush = Math.min(pushLeft, pushRight, pushBack, pushFwd);
        if (minPush === pushLeft) nx = box.minX - radius;
        else if (minPush === pushRight) nx = box.maxX + radius;
        else if (minPush === pushBack) nz = box.minZ - radius;
        else nz = box.maxZ + radius;
      }
    }

    return { x: nx, y: ny, z: nz, hitWall, grounded };
  }

  /** Highest surface the cylinder would stand on at this spot. */
  standingY(x: number, _y: number, z: number, _radius: number, _height: number): number {
    return this.surfaceHeight(x, z, 60);
  }

  /** Ray vs boxes (slab method). Used by hitscan weapons and line of sight. */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDistance: number,
  ): { distance: number; point: THREE.Vector3; normal: THREE.Vector3; box: ColliderBox } | null {
    let bestT = maxDistance;
    let best: ColliderBox | null = null;
    let bestAxis = 0;
    let bestSign = 1;

    const invX = dir.x === 0 ? Number.POSITIVE_INFINITY : 1 / dir.x;
    const invY = dir.y === 0 ? Number.POSITIVE_INFINITY : 1 / dir.y;
    const invZ = dir.z === 0 ? Number.POSITIVE_INFINITY : 1 / dir.z;

    // Broad phase: march the ray through the hash grid cells.
    const visited = new Set<string>();
    const step = CELL_SIZE * 0.5;
    for (let t = 0; t <= bestT; t += step) {
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      const cx = Math.floor(px / CELL_SIZE);
      const cz = Math.floor(pz / CELL_SIZE);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const key = `${cx + ox},${cz + oz}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const cell = this.cells.get(key);
          if (!cell) continue;
          for (const box of cell.boxes) {
            if (!box.solid) continue;
            const hit = rayBoxT(origin, invX, invY, invZ, box);
            if (hit && hit.t < bestT) {
              bestT = hit.t;
              best = box;
              bestAxis = hit.axis;
              bestSign = hit.sign;
            }
          }
        }
      }
    }

    if (!best) {
      // Ground plane fallback keeps shots from flying to infinity.
      if (dir.y < -1e-6) {
        const t = (this.groundY - origin.y) / dir.y;
        if (t > 0 && t <= maxDistance) {
          const point = new THREE.Vector3(origin.x + dir.x * t, this.groundY, origin.z + dir.z * t);
          return {
            distance: t,
            point,
            normal: new THREE.Vector3(0, 1, 0),
            box: {
              minX: point.x, maxX: point.x, minY: this.groundY, maxY: this.groundY,
              minZ: point.z, maxZ: point.z, topY: this.groundY, solid: false, tags: ['ground'],
            },
          };
        }
      }
      return null;
    }

    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    const normal = new THREE.Vector3(
      bestAxis === 0 ? bestSign : 0,
      bestAxis === 1 ? bestSign : 0,
      bestAxis === 2 ? bestSign : 0,
    );
    return { distance: bestT, point, normal, box: best };
  }

  /** True when a straight line between two points is unobstructed (AI vision). */
  hasLineOfSight(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
  ): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return true;
    const hit = this.raycast(from, { x: dx / len, y: dy / len, z: dz / len }, len - 0.35);
    return hit === null;
  }
}

function rayBoxT(
  origin: { x: number; y: number; z: number },
  invX: number,
  invY: number,
  invZ: number,
  box: ColliderBox,
): { t: number; axis: number; sign: number } | null {
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  let axis = 0;
  let sign = 1;

  const axes: [number, number, number, number][] = [
    [origin.x, box.minX, box.maxX, invX],
    [origin.y, box.minY, box.maxY, invY],
    [origin.z, box.minZ, box.maxZ, invZ],
  ];

  for (let i = 0; i < 3; i++) {
    const [o, lo, hi, inv] = axes[i] as [number, number, number, number];
    if (Number.isFinite(inv)) {
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        axis = i;
        sign = s;
      }
      tMax = Math.min(tMax, t2);
    } else if (o < lo || o > hi) {
      return null;
    }
  }

  if (tMax < Math.max(tMin, 0) || tMin < 0) return null;
  return { t: tMin, axis, sign };
}
