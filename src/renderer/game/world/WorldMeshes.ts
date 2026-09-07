import * as THREE from 'three';
import type { CollisionWorld } from '../physics/CollisionWorld';

/**
 * Helper that keeps a Three.js mesh and its collider in lockstep, and tracks
 * every resource so the world can be disposed cleanly between sessions.
 */

export type BoxGeometryLike = { width: number; height: number; depth: number };

export class WorldBuilder {
  readonly group = new THREE.Group();
  private materials = new Map<string, THREE.Material>();
  private geometries = new Set<THREE.BufferGeometry>();

  constructor(private collision: CollisionWorld) {
    this.group.name = 'world';
  }

  material(key: string, color: number, options: THREE.MeshLambertMaterialParameters = {}): THREE.Material {
    const existing = this.materials.get(key);
    if (existing) return existing;
    const mat = new THREE.MeshLambertMaterial({ color, flatShading: true, ...options });
    this.materials.set(key, mat);
    return mat;
  }

  private track(geometry: THREE.BufferGeometry, mesh: THREE.Mesh): THREE.Mesh {
    this.geometries.add(geometry);
    this.group.add(mesh);
    return mesh;
  }

  /** Freeze transforms once the world is built (skips per-frame matrix work). */
  freeze(): void {
    this.group.traverse((obj) => {
      obj.updateMatrix();
      obj.matrixAutoUpdate = false;
    });
  }

  /** Adds a mesh + a matching AABB collider derived from its geometry. */
  box(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    opts: {
      solid?: boolean;
      rotateY?: number;
      rotateX?: number;
      tags?: string[];
      /** Explicit collider size; defaults to the geometry bounds. */
      size?: { x: number; y: number; z: number };
      /** Round the footprint to this radius, for cylinder props drawn as cylinders. */
      radius?: number;
      noCollider?: boolean;
    } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(opts.rotateX ?? 0, opts.rotateY ?? 0, 0);
    this.track(geometry, mesh);

    if (!opts.noCollider) {
      const size = opts.size ?? this.sizeOf(geometry);
      const angle = opts.rotateY ?? 0;
      // Rotating X (a cylinder laid down) keeps a symmetric footprint.
      const halfX = (opts.rotateX ? size.z : size.x) / 2;
      const halfZ = (opts.rotateX ? size.x : size.z) / 2;
      const cos = Math.abs(Math.cos(angle));
      const sin = Math.abs(Math.sin(angle));
      const ex = halfX * cos + halfZ * sin;
      const ez = halfX * sin + halfZ * cos;
      // Primitives are centered on their own origin and every caller places
      // them by center, so the collider has to follow the geometry's vertical
      // bounds. Treating `y` as the bottom shifted each prop up by half its
      // height, which is what snagged the player on invisible walls.
      const spanY = this.verticalSpan(geometry, size.y);
      this.collision.addRawBox({
        minX: x - ex,
        maxX: x + ex,
        minY: y + spanY.min,
        maxY: y + spanY.max,
        minZ: z - ez,
        maxZ: z + ez,
        topY: y + spanY.max,
        solid: opts.solid ?? true,
        tags: opts.tags ?? [],
        // The AABB above only encloses the rotated footprint. Passing the yaw and
        // the real half-extents is what lets a crate you can see be a crate you can
        // walk up to: the enclosing box alone was a phantom wall around every
        // rotated prop, widest at 45 degrees where it is 41% bigger than the mesh.
        rotY: opts.rotateX ? undefined : (opts.rotateY || undefined),
        halfX,
        halfZ,
        radius: opts.radius,
      });
    }
    return mesh;
  }

  /**
   * Vertical extent of a collider relative to the mesh centre. Primitives are
   * modelled around their own origin, so the honest answer is the geometry's
   * bounding box; `height` is a fallback for a geometry without bounds.
   */
  private verticalSpan(geometry: THREE.BufferGeometry, height: number): { min: number; max: number } {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb) {
      const half = height / 2;
      return { min: -half, max: half };
    }
    return { min: bb.min.y, max: bb.max.y };
  }

  /** Collider footprint for a primitive: box params first, bounds otherwise. */
  private sizeOf(geometry: THREE.BufferGeometry): { x: number; y: number; z: number } {
    const params = (geometry as unknown as { parameters?: Record<string, number> }).parameters;
    if (params && typeof params.width === 'number' && typeof params.height === 'number') {
      return { x: params.width, y: params.height, z: params.depth };
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb) return { x: 1, y: 1, z: 1 };
    const size = new THREE.Vector3();
    bb.getSize(size);
    return { x: size.x, y: size.y, z: size.z };
  }

  /** Non-solid decoration (pipes, antennae, props you can walk through). */
  decor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    rotation?: { x?: number; y?: number; z?: number },
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    if (rotation) mesh.rotation.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
    return this.track(geometry, mesh);
  }

  /**
   * Bakes a mesh (already positioned/rotated) into the group and registers an
   * approximate AABB collider derived from its geometry bounding box.
   */
  bake(mesh: THREE.Mesh, opts: { solid?: boolean; shrink?: number; tags?: string[] } = {}): THREE.Mesh {
    mesh.updateMatrix();
    mesh.updateWorldMatrix(false, false);
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    this.geometries.add(geo);
    this.group.add(mesh);

    if (bb) {
      const shrink = opts.shrink ?? 0.02;
      const size = new THREE.Vector3();
      bb.getSize(size);
      const center = new THREE.Vector3();
      bb.getCenter(center);
      // Local bbox -> world using the mesh's baked matrix.
      center.applyMatrix4(mesh.matrix);
      const rotation = new THREE.Euler().setFromRotationMatrix(mesh.matrix);
      const cos = Math.abs(Math.cos(rotation.y));
      const sin = Math.abs(Math.sin(rotation.y));
      const ex = ((size.x * Math.abs(Math.cos(rotation.x))) / 2 + (size.z * Math.abs(Math.sin(rotation.x))) / 2) * (1 - shrink);
      const ez = ((size.z * cos) / 2 + (size.x * sin) / 2) * (1 - shrink);
      this.collision.addRawBox({
        minX: center.x - Math.max(ex, ez) * 0.75,
        maxX: center.x + Math.max(ex, ez) * 0.75,
        minY: center.y - size.y / 2,
        maxY: center.y + size.y / 2,
        minZ: center.z - Math.max(ex, ez) * 0.75,
        maxZ: center.z + Math.max(ex, ez) * 0.75,
        topY: center.y + size.y / 2,
        solid: opts.solid ?? true,
        tags: opts.tags ?? ['baked'],
      });
    }
    return mesh;
  }

  /**
   * Bakes a merged mesh of many props into ONE draw call and registers a
   * simplified set of colliders from the supplied footprint boxes. `rotY` keeps a
   * rotated prop's collider matched to how it is drawn (the yawed mesh used to be
   * an axis-aligned wall you could not walk up to), and `radius` gives round props
   * a round footprint.
   */
  bakeMerged(
    mesh: THREE.Mesh,
    colliders: { x: number; y: number; z: number; w: number; h: number; d: number; tags?: string[]; rotY?: number; radius?: number }[],
    solid = true,
  ): THREE.Mesh {
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    this.geometries.add(mesh.geometry);
    this.group.add(mesh);
    for (const c of colliders) {
      this.collision.addRawBox({
        minX: c.x - c.w / 2,
        maxX: c.x + c.w / 2,
        minY: c.y,
        maxY: c.y + c.h,
        minZ: c.z - c.d / 2,
        maxZ: c.z + c.d / 2,
        topY: c.y + c.h,
        solid,
        tags: c.tags ?? ['prop'],
        rotY: c.rotY,
        radius: c.radius,
      });
    }
    return mesh;
  }

  /** Walkable plateau registered in the height field (no visible geometry). */
  plateau(x: number, z: number, y: number, radius: number): void {
    this.collision.addHeightSample(x, z, y, radius);
  }

  dispose(): void {
    for (const geo of this.geometries) geo.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.group.clear();
  }
}

/**
 * Bakes a list of geometry+matrix pairs into one non-indexed BufferGeometry so
 * hundreds of props collapse into a single draw call.
 */
export function mergeSimpleMeshes(
  entries: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[],
): THREE.BufferGeometry | null {
  if (entries.length === 0) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const normalMatrix = new THREE.Matrix3();
  const point = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (const entry of entries) {
    const source = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry;
    const pos = source.getAttribute('position') as THREE.BufferAttribute;
    const nrm = source.getAttribute('normal') as THREE.BufferAttribute;
    normalMatrix.getNormalMatrix(entry.matrix);
    for (let i = 0; i < pos.count; i++) {
      point.fromBufferAttribute(pos, i).applyMatrix4(entry.matrix);
      positions.push(point.x, point.y, point.z);
      dir.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      normals.push(dir.x, dir.y, dir.z);
    }
    if (source !== entry.geometry) source.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
