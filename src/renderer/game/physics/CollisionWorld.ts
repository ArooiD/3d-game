import * as THREE from 'three';

/**
 * Lightweight collision world purpose-built for this game:
 *
 *  - colliders are boxes, optionally yawed (rotY), or vertical cylinders
 *  - characters are vertical capsules resolved with minimum translation vectors
 *    against every collider they touch, which slides along a face of any angle
 *    instead of snapping to the world axes
 *  - a uniform spatial hash keeps query cost flat across the 300x300 map
 *
 * A physics engine (cannon-es / rapier) would work too, but this keeps static
 * collision queries local without an additional runtime dependency.
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
  /**
   * Yaw of the footprint around its centre. min/max stay the enclosing AABB so
   * the spatial hash and the broad phase work unchanged, but penetration and
   * rays are computed in the rotated frame. Without this a crate turned 45°
   * behaved like a much larger axis-aligned one, leaving invisible walls.
   */
  rotY?: number;
  /**
   * Real footprint half-extents. For a yawed box the min/max above are only the
   * enclosing AABB, so penetration, coverage and rays need the true extents.
   */
  halfX?: number;
  halfZ?: number;
  /** Vertical cylinder collider around the footprint centre, preferred over the box. */
  radius?: number;
}

interface Cell {
  boxes: ColliderBox[];
}

/**
 * A collider whose walkable top is at or below the feet is floor, not wall.
 * Without this rule the face of the ledge you are standing on pushes you back
 * every frame, which reads as sticking to the edge while walking or falling.
 */
const STEP_GRACE = 0.06;
/**
 * Depth below which contact is treated as clear. A body resting exactly on a face
 * and then sliding along it re-reports float-rounding overshoot, and treating that
 * noise as a wall made the sweep refuse the step outright.
 */
const CONTACT_EPS = 1e-9;

/**
 * How far a body is eased off a face when the sweep cannot find any free distance
 * along the requested move. Two millimetres is below anything a player can see but
 * enough to get around a convex corner, where every candidate step overshoots the
 * curved contact by a hair however short the step is.
 */
const CONTACT_NUDGE = 0.002;
const CELL_SIZE = 10;
const EPSILON = 1e-4;
/** Fraction of a height sample kept flat before it tapers down to the ground. */
const SAMPLE_CORE = 0.7;
/** Contact search rings used to free a body that ends up inside geometry. */
const ESCAPE_RINGS = [0.1, 0.22, 0.4, 0.62, 0.9, 1.25, 1.7, 2.2];
/** Directions sampled per ring when looking for free space. */
const ESCAPE_DIRS = 16;

interface Push {
  box: ColliderBox;
  /** World-space translation that frees the body from this collider. */
  px: number;
  pz: number;
  /** Contact normal in world space, pointing away from the collider. */
  nx: number;
  nz: number;
  depth: number;
}

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitWall: boolean;
  grounded: boolean;
  hitCeiling: boolean;
  /** Normal of the last wall contact, so the caller can slide along the face. */
  normalX: number;
  normalZ: number;
  /** Set when the body started the step inside geometry and had to be freed. */
  escaped: boolean;
}

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
    options: { solid?: boolean; tags?: string[]; rotY?: number; radius?: number } = {},
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
    if (options.rotY) {
      box.rotY = options.rotY;
      // The hash and the broad phase need the enclosing AABB of the yawed rect.
      const cos = Math.abs(Math.cos(options.rotY));
      const sin = Math.abs(Math.sin(options.rotY));
      const ex = (size.x / 2) * cos + (size.z / 2) * sin;
      const ez = (size.x / 2) * sin + (size.z / 2) * cos;
      box.halfX = size.x / 2;
      box.halfZ = size.z / 2;
      box.minX = center.x - ex;
      box.maxX = center.x + ex;
      box.minZ = center.z - ez;
      box.maxZ = center.z + ez;
    }
    if (options.radius !== undefined) {
      box.radius = options.radius;
      box.minX = center.x - options.radius;
      box.maxX = center.x + options.radius;
      box.minZ = center.z - options.radius;
      box.maxZ = center.z + options.radius;
    }
    this.insert(box);
    return box;
  }

  /** Register a box that is already expressed as min/max values. */
  addRawBox(box: ColliderBox): ColliderBox {
    if (box.radius !== undefined) {
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      box.minX = cx - box.radius;
      box.maxX = cx + box.radius;
      box.minZ = cz - box.radius;
      box.maxZ = cz + box.radius;
      box.rotY = undefined;
      box.halfX = undefined;
      box.halfZ = undefined;
    } else if (box.rotY) {
      // Keep the real footprint and widen the AABB to enclose the yawed rect, the
      // same way addBox does.
      const cos = Math.abs(Math.cos(box.rotY));
      const sin = Math.abs(Math.sin(box.rotY));
      const hx = box.halfX ?? (box.maxX - box.minX) / 2;
      const hz = box.halfZ ?? (box.maxZ - box.minZ) / 2;
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      box.halfX = hx;
      box.halfZ = hz;
      box.minX = cx - (hx * cos + hz * sin);
      box.maxX = cx + (hx * cos + hz * sin);
      box.minZ = cz - (hx * sin + hz * cos);
      box.maxZ = cz + (hx * sin + hz * cos);
    }
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
      const candidate = this.sampleHeight(sample, x, z);
      if (candidate > y) y = candidate;
    }
    return y;
  }

  /**
   * Height contributed by one stamp. The outer band tapers to flat ground instead
   * of stopping dead at the radius: that hard ring was a cliff far taller than the
   * step height, so walking off the edge of a plateau hung the feet for a frame and
   * then dropped the body, which is what snagged players on invisible ledges.
   */
  private sampleHeight(sample: { x: number; z: number; y: number; radius: number }, x: number, z: number): number {
    const dx = x - sample.x;
    const dz = z - sample.z;
    const r = sample.radius;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= r) return this.groundY;
    const core = r * SAMPLE_CORE;
    if (d <= core) return sample.y;
    const u = (d - core) / (r - core);
    return this.groundY + (sample.y - this.groundY) * (1 - u);
  }

  /** Standing height: ground plus any solid box top under the point. */
  surfaceHeight(x: number, z: number, maxY = 40): number {
    let best = this.groundHeight(x, z);
    for (const box of this.queryArea(x, z, 0.001)) {
      if (!box.solid || !this.coversPoint(box, x, z, 0)) continue;
      if (box.topY <= maxY + EPSILON && box.topY > best) best = box.topY;
    }
    return best;
  }

  /**
   * Surface a body of `radius` can rest on when its feet are at `feetY`. Unlike
   * `surfaceHeight`, which samples the center point, this asks whether the
   * footprint disc touches a top that is level with the feet. That is what keeps
   * a capsule standing for the frames where its center has not yet caught up with
   * a ledge it stepped onto; sampling the center alone dropped the player straight
   * back off the step, which is the stutter felt near platform edges.
   */
  footprintSurface(x: number, z: number, feetY: number, radius: number, snap = 0.06): number {
    let best = this.groundHeight(x, z);
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid) continue;
      if (!this.coversPoint(box, x, z, radius)) continue;
      if (box.topY > feetY + snap || box.topY <= best) continue;
      best = box.topY;
    }
    return best;
  }

  /** Overlap test for a vertical cylinder (character body). */
  overlaps(x: number, y: number, z: number, radius: number, height: number): ColliderBox[] {
    const hits: ColliderBox[] = [];
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid || !this.verticalOverlap(box, y, height)) continue;
      if (this.penetration(box, x, z, radius)) hits.push(box);
    }
    return hits;
  }

  /**
   * Resolve a move for a cylinder, sliding along collider faces at any angle.
   * Returns the adjusted position. `maxStep` allows walking up small ledges.
   */
  moveCylinder(
    pos: { x: number; y: number; z: number },
    delta: { x: number; y: number; z: number },
    radius: number,
    height: number,
    maxStep: number,
  ): MoveResult {
    const result: MoveResult = {
      x: pos.x, y: pos.y, z: pos.z,
      hitWall: false, grounded: false, hitCeiling: false,
      normalX: 0, normalZ: 0, escaped: false,
    };
    // Bounded displacement prevents tunnelling even for impulses and low FPS.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)) / Math.max(0.05, radius * 0.5)));
    const dx = delta.x / steps, dy = delta.y / steps, dz = delta.z / steps;
    for (let i = 0; i < steps; i++) {
      // A body that starts a step inside geometry has no legal move: every face
      // reports a penetration and a per-axis clamp simply refuses to move it,
      // which froze the player until respawn. Free it first - unless the geometry
      // it overlaps is a low ledge it could simply step onto: escaping sideways
      // from that threw the body back off the ledge every frame it approached one,
      // so the ledge edge became an oscillation rather than a step.
      const sunk = this.deepestPush(result.x, result.z, result.y, height, radius);
      const canRiseOnto =
        !!sunk &&
        dy <= 0 &&
        sunk.box.topY > result.y &&
        sunk.box.topY - result.y <= maxStep &&
        !this.blocksAt(result.x, result.z, sunk.box.topY, radius, height);
      if (!canRiseOnto) {
        const freed = this.escapePosition(result.x, result.y, result.z, radius, height, { x: dx, z: dz });
        if (freed) {
          result.x = freed.x;
          result.z = freed.z;
          result.escaped = true;
        }
      }
      // Ring search only finds a free spot if it is a whole ring away. Contact with
      // a yawed corner can leave the body a centimetre inside a face, where every
      // candidate position is still "blocked" by that overshoot and the move is
      // refused outright. Push that overshoot out along the contact normal first:
      // the body can then slide along the face on this same step.
      const embedded = this.deepestPush(result.x, result.z, result.y, height, radius);
      if (embedded) {
        // Inside a low ledge, the way out is up, not sideways: a capsule whose feet
        // sank into a 0.3 m floor slab was being pushed back along its incoming
        // direction every frame and never gained ground on it. Stepping onto the
        // top is what the same ledge does when approached from outside.
        const top = embedded.box.topY;
        if (dy <= 0 && top > result.y && top - result.y <= maxStep &&
            !this.blocksAt(result.x, result.z, top, radius, height)) {
          result.y = top;
        } else {
          result.x += embedded.px;
          result.z += embedded.pz;
          result.hitWall = true;
          result.normalX = embedded.nx;
          result.normalZ = embedded.nz;
        }
      }
      const supported = result.y <= this.footprintSurface(result.x, result.z, result.y, radius) + EPSILON;
      /** Ledge height gained by a step-up this sub-step, if any. */
      let steppedTo = Number.NEGATIVE_INFINITY;
      const slide = this.resolveHorizontal(result, dx, dz, result.y, radius, height, maxStep, supported, dy);
      steppedTo = slide.steppedTo;
      if (slide.hitWall) {
        result.hitWall = true;
        result.normalX = slide.nx;
        result.normalZ = slide.nz;
      }
      let ny = result.y + dy;
      if (dy > 0 && !result.hitCeiling) {
        for (const box of this.queryArea(result.x, result.z, radius)) {
          if (!box.solid || !this.coversPoint(box, result.x, result.z, radius)) continue;
          if (result.y + height <= box.minY + EPSILON && ny + height >= box.minY) {
            ny = Math.min(ny, box.minY - height);
            result.hitCeiling = true;
          }
        }
      } else if (result.hitCeiling) ny = result.y;
      if (steppedTo > result.y) {
        // Stay on the ledge even while the center is a moment short of it; the
        // horizontal move is already committed and support arrives next frame.
        result.y = Math.max(steppedTo, ny);
        result.grounded = true;
      } else {
        // Footprint, not center: a capsule that just stepped onto a ledge is
        // still leaning on it with its edge while the center catches up. The snap
        // spans a full step, so a disc overhanging a steppable ledge rests on its
        // top instead of dropping to the ground below it and waking the depenetration
        // against the ledge it can simply stand on.
        const surface = this.footprintSurface(result.x, result.z, result.y, radius, maxStep);
        result.grounded = dy <= 0 && ny <= surface + EPSILON;
        result.y = result.grounded ? surface : ny;
      }
    }
    return result;
  }

  /**
   * Push a cylinder out of every collider it overlaps, keeping the leftover motion
   * as tangential slide. One pass per contact instead of one pass per world axis:
   * the axis-by-axis clamp froze both axes at an outer corner, so brushing a corner
   * head-on dead-stopped the body mid-wall.
   */
  private resolveHorizontal(
    result: { x: number; z: number },
    dx: number,
    dz: number,
    y: number,
    radius: number,
    height: number,
    maxStep: number,
    supported: boolean,
    dy: number,
  ): { steppedTo: number; hitWall: boolean; nx: number; nz: number } {
    let steppedTo = Number.NEGATIVE_INFINITY;
    let hitWall = false;
    let nx = 0;
    let nz = 0;
    let wantX = dx;
    let wantZ = dz;
    for (let pass = 0; pass < 4; pass++) {
      if (wantX === 0 && wantZ === 0) break;
      const tx = result.x + wantX;
      const tz = result.z + wantZ;
      const push = this.deepestPush(tx, tz, y, height, radius);
      if (!push) {
        result.x = tx;
        result.z = tz;
        break;
      }
      const rise = push.box.topY - y;
      // A step needs support and enough headroom through the whole rise.
      if (supported && dy <= 0 && rise > 0 && rise <= maxStep &&
          !this.blocksAt(result.x, result.z, push.box.topY, radius, height) &&
          !this.blocksAt(tx, tz, push.box.topY, radius, height)) {
        // Move first, rise below. Clamping a step instead pinned the body a radius
        // short of the face forever: the center only gains support once it is over
        // the ledge, and the clamp made that unreachable.
        result.x = tx;
        result.z = tz;
        steppedTo = Math.max(steppedTo, push.box.topY);
        break;
      }
      // Stop at the face instead of stepping into it and pushing back out. A
      // sub-step is longer than a thin wall, so committing the target first let the
      // body land inside the wall and the depenetration threw it out the far side.
      const reach = this.freeFraction(result.x, result.z, wantX, wantZ, y, height, radius);
      if (reach <= 0) {
        // Around a convex corner every candidate step, however short, overshoots
        // the curved contact by a hair, so the sweep finds no free distance at all
        // and the body hangs on the corner. Re-ask for the tangential part of the
        // move with a two-millimetre allowance: enough to slip past the corner, far
        // too small to notice. Any leftover overlap is pushed out next sub-step, and
        // a head-on push into a flat wall still stops exactly at its face.
        const nX = push.nx;
        const nZ = push.nz;
        const into = wantX * nX + wantZ * nZ;
        const slideX = wantX - nX * into;
        const slideZ = wantZ - nZ * into;
        const slideFrac = this.freeFraction(result.x, result.z, slideX, slideZ, y, height, radius - CONTACT_NUDGE);
        result.x += slideX * slideFrac;
        result.z += slideZ * slideFrac;
        hitWall = true;
        nx = nX;
        nz = nZ;
        if (slideFrac >= 1) break;
        wantX = slideX * (1 - slideFrac);
        wantZ = slideZ * (1 - slideFrac);
        continue;
      }
      result.x += wantX * reach;
      result.z += wantZ * reach;
      hitWall = true;
      nx = push.nx;
      nz = push.nz;
      const into = wantX * nx + wantZ * nz;
      if (into < 0) {
        // Retry whatever is left of the request along the face: this is the slide.
        const scale = 1 - reach;
        wantX = (wantX - nx * into) * scale;
        wantZ = (wantZ - nz * into) * scale;
      } else {
        break;
      }
    }
    return { steppedTo, hitWall, nx, nz };
  }

  /**
   * How far along a requested move the body can go before it touches anything,
   * found by bisection. Sub-steps are longer than a thin wall, so a wall has to be
   * found by search rather than by testing the step's endpoint.
   */
  private freeFraction(
    x: number,
    z: number,
    dx: number,
    dz: number,
    y: number,
    height: number,
    radius: number,
  ): number {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (this.deepestPush(x + dx * mid, z + dz * mid, y, height, radius)) hi = mid;
      else lo = mid;
    }
    return lo;
  }

  /**
   * Deepest penetration of a body at (x, z) among the colliders that count as
   * walls. Tops at or below the feet are floor to stand on, not a face to be
   * pushed off — that distinction is what used to glue players to platform edges.
   */
  private deepestPush(x: number, z: number, y: number, height: number, radius: number): Push | null {
    let best: Push | null = null;
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid || box.topY <= y + STEP_GRACE) continue;
      if (!this.verticalOverlap(box, y, height)) continue;
      const push = this.penetration(box, x, z, radius);
      if (push && (!best || push.depth > best.depth)) best = push;
    }
    return best;
  }

  /** True when a body of this size cannot stand at (x, y, z). */
  blocksAt(x: number, z: number, y: number, radius: number, height: number): boolean {
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid || !this.verticalOverlap(box, y, height)) continue;
      if (this.penetration(box, x, z, radius)) return true;
    }
    return false;
  }

  /**
   * Nearest position where a body of this size fits, searched as widening rings
   * around the current spot, biased toward `bias` so a knockback out of geometry
   * follows the direction the body was travelling. Returns null when the body
   * already fits. When nothing is free — a slot narrower than the body — the spot
   * with the least penetration wins, which walks the body toward the wide end of
   * the slot instead of pinning it forever.
   */
  escapePosition(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    bias: { x: number; z: number } = { x: 0, z: 0 },
  ): { x: number; z: number } | null {
    if (!this.deepestPush(x, z, y, height, radius)) return null;
    const len = Math.hypot(bias.x, bias.z);
    const bx = len > 1e-6 ? bias.x / len : 0;
    const bz = len > 1e-6 ? bias.z / len : 0;
    const dirs: { x: number; z: number }[] = [];
    for (let i = 0; i < ESCAPE_DIRS; i++) {
      const a = (i / ESCAPE_DIRS) * Math.PI * 2;
      dirs.push({ x: Math.cos(a), z: Math.sin(a) });
    }
    dirs.sort((p, q) => (q.x * bx + q.z * bz) - (p.x * bx + p.z * bz));
    for (const ring of ESCAPE_RINGS) {
      for (const d of dirs) {
        const px = x + d.x * ring;
        const pz = z + d.z * ring;
        if (!this.deepestPush(px, pz, y, height, radius)) return { x: px, z: pz };
      }
    }
    let bestX = x;
    let bestZ = z;
    let bestDepth = this.totalPenetration(x, z, y, height, radius);
    for (const d of dirs) {
      for (const ring of ESCAPE_RINGS) {
        const px = x + d.x * ring;
        const pz = z + d.z * ring;
        const depth = this.totalPenetration(px, pz, y, height, radius);
        if (depth < bestDepth - 0.01) {
          bestDepth = depth;
          bestX = px;
          bestZ = pz;
        }
      }
    }
    if (bestX === x && bestZ === z) return null;
    return { x: bestX, z: bestZ };
  }

  /** Combined wall penetration depth of a body, 0 when it fits. */
  totalPenetration(x: number, z: number, y: number, height: number, radius: number): number {
    let total = 0;
    for (const box of this.queryArea(x, z, radius)) {
      if (!box.solid || box.topY <= y + STEP_GRACE) continue;
      if (!this.verticalOverlap(box, y, height)) continue;
      const push = this.penetration(box, x, z, radius);
      if (push) total += push.depth;
    }
    return total;
  }

  /** Vertical span test: the body occupies [y, y + height]. */
  private verticalOverlap(box: ColliderBox, y: number, height: number): boolean {
    return y + height > box.minY + EPSILON && y < box.maxY - EPSILON;
  }

  /**
   * Minimum translation of a circle at (x, z) out of one collider, in world space,
   * or null when the circle is clear. Landing exactly on the face is deliberate:
   * penetration is strict, so a resolved body stays resolved and does not jitter.
   */
  private penetration(box: ColliderBox, x: number, z: number, radius: number): Push | null {
    if (box.radius !== undefined) {
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      const dx = x - cx;
      const dz = z - cz;
      const reach = box.radius + radius;
      const d = Math.hypot(dx, dz);
      if (d >= reach - CONTACT_EPS) return null;
      let nx: number;
      let nz: number;
      if (d < 1e-6) {
        nx = 1;
        nz = 0;
      } else {
        nx = dx / d;
        nz = dz / d;
      }
      const depth = reach - d;
      return { box, px: nx * depth, pz: nz * depth, nx, nz, depth };
    }
    // Box, possibly yawed: resolve in the collider's own frame. The frame is
    // centre-relative with half-extents, so the extents cannot drift out of sync
    // with the world AABB once a yaw is applied.
    const rot = box.rotY ?? 0;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const hx = box.halfX ?? (box.maxX - box.minX) / 2;
    const hz = box.halfZ ?? (box.maxZ - box.minZ) / 2;
    let lx = x - cx;
    let lz = z - cz;
    if (rot !== 0) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const ox = lx;
      const oz = lz;
      lx = ox * cos - oz * sin;
      lz = ox * sin + oz * cos;
    }
    const nearestX = Math.max(-hx, Math.min(lx, hx));
    const nearestZ = Math.max(-hz, Math.min(lz, hz));
    const dx = lx - nearestX;
    const dz = lz - nearestZ;
    let lnx: number;
    let lnz: number;
    let depth: number;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) {
      // Center inside the footprint: leave through the closest face.
      const toMinX = lx + hx + radius;
      const toMaxX = hx - lx + radius;
      const toMinZ = lz + hz + radius;
      const toMaxZ = hz - lz + radius;
      const min = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
      lnx = -1;
      lnz = 0;
      if (min === toMaxX) { lnx = 1; lnz = 0; }
      if (min === toMinZ) { lnx = 0; lnz = -1; }
      if (min === toMaxZ) { lnx = 0; lnz = 1; }
      depth = min;
    } else {
      if (d >= radius - CONTACT_EPS) return null;
      lnx = dx / d;
      lnz = dz / d;
      depth = radius - d;
    }
    let nx = lnx;
    let nz = lnz;
    if (rot !== 0) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      nx = lnx * cos + lnz * sin;
      nz = -lnx * sin + lnz * cos;
    }
    return { box, px: nx * depth, pz: nz * depth, nx, nz, depth };
  }

  /** Does the footprint of a collider (grown by `pad`) contain a point? */
  coversPoint(box: ColliderBox, x: number, z: number, pad: number): boolean {
    if (box.radius !== undefined) {
      const cx = (box.minX + box.maxX) / 2;
      const cz = (box.minZ + box.maxZ) / 2;
      const r = box.radius + pad;
      const dx = x - cx;
      const dz = z - cz;
      return dx * dx + dz * dz <= r * r;
    }
    let lx = x;
    let lz = z;
    const rot = box.rotY ?? 0;
    const hx = box.halfX ?? (box.maxX - box.minX) / 2;
    const hz = box.halfZ ?? (box.maxZ - box.minZ) / 2;
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    lx -= cx;
    lz -= cz;
    if (rot !== 0) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const ox = lx;
      const oz = lz;
      lx = ox * cos - oz * sin;
      lz = ox * sin + oz * cos;
    }
    return !(lx + pad <= -hx || lx - pad >= hx || lz + pad <= -hz || lz - pad >= hz);
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

  /** Surface reachable from the current feet, never a roof overhead. */
  standingY(x: number, y: number, z: number, _radius: number, _height: number): number {
    return this.surfaceHeight(x, z, y + EPSILON);
  }

  /** Ray vs colliders. Used by hitscan weapons, line of sight and aim focus. */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDistance: number,
    radius = 0,
  ): { distance: number; point: THREE.Vector3; normal: THREE.Vector3; box: ColliderBox } | null {
    let bestT = maxDistance;
    let best: ColliderBox | null = null;
    let bestNormal = { x: 0, y: 1, z: 0 };

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
            const hit = box.radius !== undefined
              ? rayCylinderT(origin, dir, box, radius)
              : rayOrientedBoxT(origin, dir, box, radius);
            if (hit && hit.t <= bestT) {
              bestT = hit.t;
              best = box;
              bestNormal = hit.normal;
            }
          }
        }
      }
    }

    // Ground plane fallback keeps shots from flying to infinity.
    if (dir.y < -1e-6) {
      const t = (this.groundY + radius - origin.y) / dir.y;
      if (t >= 0 && t <= bestT) {
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
    if (!best) return null;

    const point = new THREE.Vector3(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);
    return { distance: bestT, point, normal: new THREE.Vector3(bestNormal.x, bestNormal.y, bestNormal.z), box: best };
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

type RayHit = { t: number; normal: { x: number; y: number; z: number } } | null;

/** Ray vs a vertical cylinder collider: exact, so silos no longer have flat faces. */
function rayCylinderT(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  box: ColliderBox,
  radius: number,
): RayHit {
  const cx = (box.minX + box.maxX) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  const r = (box.radius as number) + radius;
  const ox = origin.x - cx;
  const oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  let tNear: number;
  let tFar = Number.POSITIVE_INFINITY;
  if (a < 1e-12) {
    if (ox * ox + oz * oz > r * r) return null;
    tNear = 0;
  } else {
    const b = 2 * (ox * dir.x + oz * dir.z);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    tNear = (-b - s) / (2 * a);
    tFar = (-b + s) / (2 * a);
  }
  // Clip against the horizontal caps.
  let tMin = Math.max(0, tNear);
  let tMax = tFar;
  let capped = false;
  if (Math.abs(dir.y) > 1e-9) {
    const inv = 1 / dir.y;
    let t1 = (box.minY - radius - origin.y) * inv;
    let t2 = (box.maxY + radius - origin.y) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) { tMin = t1; capped = true; }
    tMax = Math.min(tMax, t2);
  } else if (origin.y < box.minY - radius || origin.y > box.maxY + radius) {
    return null;
  }
  if (tMax < tMin) return null;
  const t = Math.max(0, tMin);
  if (capped) return { t, normal: { x: 0, y: dir.y > 0 ? -1 : 1, z: 0 } };
  const hx = origin.x + dir.x * t - cx;
  const hz = origin.z + dir.z * t - cz;
  const h = Math.hypot(hx, hz) || 1;
  return { t, normal: { x: hx / h, y: 0, z: hz / h } };
}

/** Ray vs a yawed box: the slab test runs in the collider frame, so hits land on the visible faces. */
function rayOrientedBoxT(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  box: ColliderBox,
  radius: number,
): RayHit {
  const rot = box.rotY ?? 0;
  let ox = origin.x;
  let oz = origin.z;
  let dx = dir.x;
  let dz = dir.z;
  if (rot !== 0) {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const px = origin.x - cx;
    const pz = origin.z - cz;
    ox = px * cos - pz * sin;
    oz = px * sin + pz * cos;
    dx = dir.x * cos - dir.z * sin;
    dz = dir.x * sin + dir.z * cos;
  }

  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  let axis = 0;
  let sign = 1;

  const invX = dx === 0 ? Number.POSITIVE_INFINITY : 1 / dx;
  const invY = dir.y === 0 ? Number.POSITIVE_INFINITY : 1 / dir.y;
  const invZ = dz === 0 ? Number.POSITIVE_INFINITY : 1 / dz;

  const axes: [number, number, number, number][] = [
    [ox, box.minX - radius, box.maxX + radius, invX],
    [origin.y, box.minY - radius, box.maxY + radius, invY],
    [oz, box.minZ - radius, box.maxZ + radius, invZ],
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

  if (tMax < Math.max(tMin, 0)) return null;
  let lnx = axis === 0 ? sign : 0;
  const lny = axis === 1 ? sign : 0;
  let lnz = axis === 2 ? sign : 0;
  if (rot !== 0) {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const wx = lnx * cos + lnz * sin;
    const wz = -lnx * sin + lnz * cos;
    lnx = wx;
    lnz = wz;
  }
  return { t: Math.max(0, tMin), normal: { x: lnx, y: lny, z: lnz } };
}
