import * as THREE from 'three';
import { PLAYER_HEIGHT, PLAYER_RADIUS, WORLD_HALF, WORLD_SIZE } from '../../../shared/constants';
import { RNG } from '../core/Rng';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { WorldBuilder, mergeSimpleMeshes } from './WorldMeshes';

/**
 * The single MVP location: a 300x300 m abandoned industrial outpost in a desert
 * basin. Everything is procedural geometry (no external assets) and static props
 * are merged into a handful of draw calls.
 *
 * Natural route: Drop Pad -> Camp -> Canyon -> Refinery -> Titan Arena, running
 * roughly south-west to north-east with a walled canyon corridor in the middle.
 */

export interface Zone {
  id: string;
  name: string;
  /** Circular bounds used for zone detection and objective markers. */
  center: { x: number; z: number };
  radius: number;
  safe: boolean;
}

export interface SpawnPoint {
  x: number;
  z: number;
  zone: string;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WorldAnchors {
  playerSpawn: { x: number; y: number; z: number };
  outpost: Vec3;
  camp: Vec3;
  canyonEntry: Vec3;
  refinery: Vec3;
  bossArena: Vec3;
  pedestal: { x: number; y: number; z: number };
}

const GROUND_COLOR = 0xa87a4e;
const SKY_COLOR = 0xd9a566;
const FOG_COLOR = 0xc99a63;

export class World {
  readonly group = new THREE.Group();
  readonly builder: WorldBuilder;
  readonly zones: Zone[] = [];
  readonly spawns: Map<string, SpawnPoint[]> = new Map();
  readonly anchors: WorldAnchors;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  private spinners: { mesh: THREE.Object3D; speed: number }[] = [];
  private beacons: THREE.MeshBasicMaterial[] = [];
  private time = 0;
  private sky: THREE.Mesh | null = null;

  constructor(
    private scene: THREE.Scene,
    private collision: CollisionWorld,
    private rng: RNG,
  ) {
    this.builder = new WorldBuilder(collision);
    this.group.name = 'world-root';

    this.anchors = {
      playerSpawn: { x: -104, y: 0.2, z: 104 },
      outpost: { x: -104, y: 0.4, z: 104 },
      camp: { x: -46, y: 0.2, z: 52 },
      canyonEntry: { x: -8, y: 0.3, z: 20 },
      refinery: { x: 40, y: 0.4, z: -32 },
      bossArena: { x: 96, y: 0.6, z: -96 },
      pedestal: { x: 96, y: 1.35, z: -96 },
    };

    this.buildZones();
    this.buildAtmosphere();
    this.buildGround();
    this.buildBasin();
    this.buildDropPad();
    this.buildCamp();
    this.buildCanyon();
    this.buildRefinery();
    this.buildArena();
    this.scatterDebris();
    this.buildMapBoundary();
    this.clearSpawnPoints();

    this.group.add(this.builder.group);
    this.scene.add(this.group);
  }

  // ---------------------------------------------------------------- zones

  private buildZones(): void {
    this.zones.push(
      { id: 'drop_pad', name: 'Drop Pad', center: { x: -104, z: 104 }, radius: 34, safe: true },
      { id: 'camp', name: 'Scrap Camp', center: { x: -46, z: 52 }, radius: 40, safe: false },
      { id: 'canyon', name: 'Rust Canyon', center: { x: 4, z: 6 }, radius: 46, safe: false },
      { id: 'refinery', name: 'Slag Refinery', center: { x: 40, z: -32 }, radius: 44, safe: false },
      { id: 'arena', name: 'Titan Arena', center: { x: 96, z: -96 }, radius: 40, safe: false },
    );
  }

  zoneAt(x: number, z: number): Zone | null {
    let best: Zone | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const zone of this.zones) {
      const dx = x - zone.center.x;
      const dz = z - zone.center.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= zone.radius && dist < bestDist) {
        best = zone;
        bestDist = dist;
      }
    }
    return best;
  }

  spawnPoints(zoneId: string, count: number): SpawnPoint[] {
    const pool = this.spawns.get(zoneId) ?? [];
    const out: SpawnPoint[] = [];
    for (let i = 0; i < count && pool.length > 0; i++) {
      out.push(this.rng.pick(pool));
    }
    return out;
  }

  private addSpawns(zoneId: string, points: { x: number; z: number }[]): void {
    this.spawns.set(
      zoneId,
      points.map((p) => ({ x: p.x, z: p.z, zone: zoneId })),
    );
  }

  /**
   * Moves any spawn point a prop ended up sitting on top of. Enemies spawning
   * inside geometry walk into it and jam against the wall, which reads to the
   * player as an enemy that never shows up. Runs after every zone is built, so
   * scatter debris and the boundary are already registered. The runtime escape
   * search only covers a couple of metres, so a spawn buried in a large outcrop
   * needs this wider ring; it is cheap because it happens once at level build.
   */
  private clearSpawnPoints(): void {
    for (const [zoneId, points] of this.spawns) {
      this.spawns.set(
        zoneId,
        points.map((p) => {
          if (this.isStandable(p.x, p.z)) return p;
          const near = this.collision.escapePosition(
            p.x,
            this.collision.surfaceHeight(p.x, p.z),
            p.z,
            PLAYER_RADIUS,
            PLAYER_HEIGHT,
          );
          if (near && this.isStandable(near.x, near.z)) {
            return { x: near.x, z: near.z, zone: zoneId };
          }
          const far = this.findFreeSpotAround(p.x, p.z);
          return far ? { x: far.x, z: far.z, zone: zoneId } : p;
        }),
      );
    }
  }

  private isStandable(x: number, z: number): boolean {
    const y = this.collision.surfaceHeight(x, z);
    return this.collision.totalPenetration(x, z, y, PLAYER_HEIGHT, PLAYER_RADIUS) <= 0.05;
  }

  /** Widening ring search for a spot a player-sized body can stand on. */
  private findFreeSpotAround(x: number, z: number): { x: number; z: number } | null {
    for (let ring = 1; ring <= 12; ring++) {
      const r = ring * 1.5;
      const samples = ring * 8;
      for (let i = 0; i < samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (this.isStandable(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ atmosphere

  private buildAtmosphere(): void {
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(FOG_COLOR, 60, 320);

    const hemi = new THREE.HemisphereLight(0xffd9a8, 0x4a3520, 1.05);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffe4b0, 1.35);
    sun.position.set(-80, 120, 60);
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.35);
    rim.position.set(90, 40, -120);
    this.scene.add(rim);

    // Cheap sky dome: one mesh, unlit, gives the horizon a heat-haze gradient.
    const geo = new THREE.SphereGeometry(460, 24, 14);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2e5a86) },
        mid: { value: new THREE.Color(0xd9a566) },
        bottom: { value: new THREE.Color(0x6b4526) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 top;
        uniform vec3 mid;
        uniform vec3 bottom;
        varying vec3 vPos;
        void main() {
          float h = clamp(vPos.y / 460.0, -1.0, 1.0);
          vec3 col = h > 0.06 ? mix(mid, top, smoothstep(0.06, 0.75, h))
                              : mix(mid, bottom, smoothstep(0.0, -0.4, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.name = 'sky';
    this.sky.frustumCulled = false;
    this.disposables.push(geo, mat);
    this.scene.add(this.sky);
  }

  // ---------------------------------------------------------------- ground

  private buildGround(): void {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE + 260, WORLD_SIZE + 260, 72, 72);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors: number[] = [];
    const base = new THREE.Color(GROUND_COLOR);
    const dark = new THREE.Color(0x7d5734);
    const pale = new THREE.Color(0xc7a06a);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Gentle dune undulation, kept well below gameplay tolerances.
      const h =
        Math.sin(x * 0.021) * Math.cos(z * 0.017) * 1.5 +
        Math.sin(x * 0.061 + z * 0.043) * 0.5;
      pos.setY(i, h - 0.35);
      const t = (Math.sin(x * 0.05) * Math.cos(z * 0.037) + 1) / 2;
      tmp.copy(base).lerp(t > 0.55 ? pale : dark, Math.abs(t - 0.5) * 0.9);
      colors.push(tmp.r, tmp.g, tmp.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ground';
    mesh.receiveShadow = false;
    this.disposables.push(geo, mat);
    this.group.add(mesh);

    this.collision.setFlatGround(0);
  }

  /** Rock walls ringing the playable basin so the map reads as a valley. */
  private buildBasin(): void {
    const rockMat = this.builder.material('rock', 0x8d5f3a);
    const rockMatDark = this.builder.material('rock-dark', 0x6e4728);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    this.disposables.push(geo);
    const placements: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const colliders: { x: number; y: number; z: number; w: number; h: number; d: number; rotY?: number; radius?: number }[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();

    const ring = (radius: number, count: number, minS: number, maxS: number) => {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + this.rng.float(-0.03, 0.03);
        const r = radius + this.rng.float(-12, 12);
        const s = this.rng.float(minS, maxS);
        pos.set(Math.cos(a) * r, s * 0.32, Math.sin(a) * r);
        scale.set(s * this.rng.float(0.9, 1.5), s * this.rng.float(1.1, 2.1), s * this.rng.float(0.9, 1.5));
        euler.set(this.rng.float(-0.2, 0.2), this.rng.angle(), this.rng.float(-0.2, 0.2));
        q.setFromEuler(euler);
        m.compose(pos, q, scale);
        placements.push({ geometry: geo, matrix: m.clone() });
        colliders.push({
          x: pos.x,
          y: 0,
          z: pos.z,
          w: scale.x * 1.5,
          h: scale.y * 1.4,
          d: scale.z * 1.5,
          rotY: euler.y,
        });
      }
    };

    ring(176, 60, 12, 26);
    ring(152, 26, 8, 16);

    const merged = mergeSimpleMeshes(placements);
    if (merged) {
      const mesh = new THREE.Mesh(merged, rockMat);
      mesh.name = 'basin-ring';
      this.builder.bakeMerged(mesh, colliders, true);
      this.disposables.push(merged);
    }

    // A few darker foreground outcrops for depth layering.
    const accent: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const accentColliders: typeof colliders = [];
    for (let i = 0; i < 26; i++) {
      const a = this.rng.angle();
      const r = this.rng.float(60, 150);
      const s = this.rng.float(3, 8);
      pos.set(Math.cos(a) * r, s * 0.2, Math.sin(a) * r);
      scale.set(s * 1.3, s, s * 1.2);
      euler.set(0, this.rng.angle(), 0);
      q.setFromEuler(euler);
      m.compose(pos, q, scale);
      accent.push({ geometry: geo, matrix: m.clone() });
      accentColliders.push({ x: pos.x, y: 0, z: pos.z, w: scale.x * 1.4, h: scale.y * 1.3, d: scale.z * 1.4, rotY: euler.y });
    }
    const mergedAccent = mergeSimpleMeshes(accent);
    if (mergedAccent) {
      const mesh = new THREE.Mesh(mergedAccent, rockMatDark);
      mesh.name = 'outcrops';
      this.builder.bakeMerged(mesh, accentColliders, true);
      this.disposables.push(mergedAccent);
    }
  }

  private buildMapBoundary(): void {
    // Invisible walls so the player cannot walk off the map edges.
    const t = 4;
    const limit = WORLD_HALF + 6;
    for (const [x, z, w, d] of [
      [0, -limit, WORLD_SIZE + 40, t],
      [0, limit, WORLD_SIZE + 40, t],
      [-limit, 0, t, WORLD_SIZE + 40],
      [limit, 0, t, WORLD_SIZE + 40],
    ]) {
      this.collision.addBox({ x, y: 30, z }, { x: w, y: 60, z: d }, { tags: ['boundary'] });
    }
  }

  // -------------------------------------------------------------- drop pad

  private buildDropPad(): void {
    const b = this.builder;
    const { x, z } = { x: this.anchors.outpost.x, z: this.anchors.outpost.z };
    const concrete = b.material('concrete', 0x8f8b83);
    const steel = b.material('steel', 0x748096);
    const glow = b.material('glow-safe', 0x59e0a8, { emissive: 0x2fa876, emissiveIntensity: 1 });

    // Landing pad.
    const pad = new THREE.BoxGeometry(30, 0.4, 30);
    this.disposables.push(pad);
    b.box(pad, concrete, x, 0.2, z, { tags: ['pad'] });

    // Painted hazard ring.
    const ringGeo = new THREE.RingGeometry(12.4, 13.6, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.disposables.push(ringGeo);
    const ringMesh = new THREE.Mesh(ringGeo, glow);
    ringMesh.position.set(x, 0.42, z);
    b.decor(ringGeo, glow, x, 0.42, z);

    // Four beacon posts.
    const postGeo = new THREE.BoxGeometry(0.5, 3.2, 0.5);
    const lampGeo = new THREE.BoxGeometry(0.9, 0.5, 0.9);
    this.disposables.push(postGeo, lampGeo);
    for (const [ox, oz] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) {
      b.box(postGeo, steel, x + ox, 1.6, z + oz, { tags: ['post'] });
      const lamp = b.box(lampGeo, glow, x + ox, 3.4, z + oz, { noCollider: true });
      this.spinners.push({ mesh: lamp, speed: 0 });
    }

    // Shelter roof the player can walk under (supported on four columns).
    const colGeo = new THREE.BoxGeometry(0.6, 4, 0.6);
    const roofGeo = new THREE.BoxGeometry(11, 0.45, 8);
    this.disposables.push(colGeo, roofGeo);
    for (const [ox, oz] of [[-4.6, -3.2], [4.6, -3.2], [-4.6, 3.2], [4.6, 3.2]]) {
      b.box(colGeo, steel, x + 15 + ox, 2, z - 6 + oz, { tags: ['column'] });
    }
    b.box(roofGeo, steel, x + 15, 4.2, z - 6, { tags: ['roof'] });

    // Supply crates used as cover and cover-clip points.
    const crateGeo = new THREE.BoxGeometry(2.2, 2.2, 2.2);
    const crateMat = b.material('crate', 0xa9743d);
    this.disposables.push(crateGeo);
    for (const [ox, oz] of [[-8, 6], [-6, 7.5], [7, -9], [9, 4]]) {
      b.box(crateGeo, crateMat, x + ox, 1.1, z + oz, { rotateY: this.rng.float(-0.5, 0.5), tags: ['crate'] });
    }

    this.addSpawns('drop_pad', [
      { x: x - 4, z: z - 4 },
      { x: x + 5, z: z + 3 },
      { x: x, z: z + 8 },
    ]);
  }

  // ------------------------------------------------------------------ camp

  private buildCamp(): void {
    const b = this.builder;
    const { x, z } = { x: this.anchors.camp.x, z: this.anchors.camp.z };
    const canvas = b.material('canvas', 0xb99a6b);
    const wood = b.material('wood', 0x7a5a38);
    const steel = b.material('steel', 0x748096);
    const ember = b.material('ember', 0xff8a3d, { emissive: 0xd1531b, emissiveIntensity: 1 });

    // Tents: four-sided low pyramids on a packed-dirt pad.
    const tentGeo = new THREE.ConeGeometry(3.4, 3.2, 4, 1);
    this.disposables.push(tentGeo);
    const tentSpots: [number, number][] = [[-12, -6], [-6, 9], [11, 5], [14, -9]];
    for (const [ox, oz] of tentSpots) {
      b.decor(tentGeo, canvas, x + ox, 1.6, z + oz, { y: Math.PI / 4 });
      this.collision.addBox({ x: x + ox, y: 0.9, z: z + oz }, { x: 4.4, y: 1.8, z: 4.4 }, { tags: ['tent'] });
    }

    // Central fire pit with a lit core (light is faked by an emissive box).
    const pitGeo = new THREE.CylinderGeometry(1.8, 2.1, 0.6, 10);
    const fireGeo = new THREE.IcosahedronGeometry(1.1, 0);
    this.disposables.push(pitGeo, fireGeo);
    b.box(pitGeo, steel, x, 0.3, z, { tags: ['pit'], radius: 2.1 });
    const fire = b.decor(fireGeo, ember, x, 1.1, z);
    this.spinners.push({ mesh: fire, speed: 0.9 });

    // Makeshift walls and barricades for the firefight.
    const wallGeo = new THREE.BoxGeometry(7, 2.6, 0.7);
    const scrapGeo = new THREE.BoxGeometry(2.6, 1.6, 0.5);
    this.disposables.push(wallGeo, scrapGeo);
    const walls: [number, number, number][] = [
      [-16, 0, 0.2],
      [0, 16, 0],
      [16, 2, -0.4],
      [4, -15, 0.6],
    ];
    for (const [ox, oz, rot] of walls) {
      b.box(wallGeo, wood, x + ox, 1.3, z + oz, { rotateY: rot, tags: ['wall'] });
    }
    for (let i = 0; i < 12; i++) {
      const a = this.rng.angle();
      const r = this.rng.float(8, 20);
      b.box(scrapGeo, wood, x + Math.cos(a) * r, 0.8, z + Math.sin(a) * r, {
        rotateY: this.rng.angle(),
        tags: ['scrap'],
      });
    }

    // Watchtower the player can climb via a ramp.
    this.buildTower(x - 20, z + 16, 8);

    // Shipping containers forming the camp gate toward the canyon.
    const containerGeo = new THREE.BoxGeometry(6.1, 2.7, 2.5);
    const containerMats = [
      b.material('cont-a', 0xb5623a),
      b.material('cont-b', 0x4e7f8c),
      b.material('cont-c', 0x8d8141),
    ];
    this.disposables.push(containerGeo);
    const gateSpots: [number, number, number, number][] = [
      [22, 14, 0.5, 0],
      [24, 11, 0.5, 1],
      [-22, -14, -0.3, 2],
      [8, 20, 1.4, 0],
    ];
    for (const [ox, oz, rot, mi] of gateSpots) {
      b.box(containerGeo, containerMats[mi] as THREE.Material, x + ox, 1.35, z + oz, {
        rotateY: rot,
        tags: ['container'],
      });
    }

    this.addSpawns('camp', [
      { x: x - 14, z: z - 2 },
      { x: x + 12, z: z + 8 },
      { x: x + 3, z: z - 13 },
      { x: x - 5, z: z + 14 },
      { x: x + 19, z: z - 6 },
      { x: x - 19, z: z + 10 },
    ]);
  }

  private buildTower(x: number, z: number, height: number): void {
    const b = this.builder;
    const steel = b.material('steel', 0x748096);
    const deckGeo = new THREE.BoxGeometry(5, 0.4, 5);
    const legGeo = new THREE.BoxGeometry(0.45, height, 0.45);
    const railGeo = new THREE.BoxGeometry(5, 0.9, 0.2);
    const rampGeo = new THREE.BoxGeometry(2.4, 0.3, 11.5);
    this.disposables.push(deckGeo, legGeo, railGeo, rampGeo);

    for (const [ox, oz] of [[-2.1, -2.1], [2.1, -2.1], [-2.1, 2.1], [2.1, 2.1]]) {
      b.box(legGeo, steel, x + ox, height / 2, z + oz, { tags: ['tower-leg'] });
    }
    b.box(deckGeo, steel, x, height, z, { tags: ['tower-deck'] });
    for (const [ox, oz, rot] of [[0, -2.4, 0], [0, 2.4, 0], [-2.4, 0, Math.PI / 2], [2.4, 0, Math.PI / 2]] as const) {
      b.box(railGeo, steel, x + ox, height + 0.65, z + oz, { rotateY: rot, tags: ['rail'] });
    }
    // Ramp up to the deck.
    const angle = Math.atan2(height, 11);
    const ramp = b.box(rampGeo, steel, x - 6.4, height / 2 + 0.2, z + 5.4, {
      tags: ['ramp'],
      solid: true,
    });
    ramp.rotation.x = -angle;
    ramp.updateMatrix();
    // Approximate the ramp as steps in the height field so it is walkable.
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      this.collision.addHeightSample(x - 11.2 + t * 9.6, z + 9.4 - t * 8, height * t, 2.6);
    }
  }

  // ---------------------------------------------------------------- canyon

  private buildCanyon(): void {
    const b = this.builder;
    const rock = b.material('canyon-rock', 0x9c5f36);
    const rockDark = b.material('canyon-rock-dark', 0x7b4626);

    // The canyon is a walled corridor from the camp up to the refinery gate,
    // built as two staggered rows of tall rock fins with a bridge crossing it.
    const finGeo = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(finGeo);

    const left: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const right: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    type PropCollider = { x: number; y: number; z: number; w: number; h: number; d: number; rotY?: number };
    const leftColliders: PropCollider[] = [];
    const rightColliders: PropCollider[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    // Corridor follows a curve from (-40, 34) to (26, -6).
    const path = canyonPath();
    for (let i = 0; i < path.length; i++) {
      const point = path[i] as { x: number; z: number };
      const side = 11 + this.rng.float(-1.5, 2.5);
      const tangent = tangentAt(path, i);
      const nx = -tangent.z;
      const nz = tangent.x;
      for (const dir of [1, -1]) {
        const h = this.rng.float(9, 24);
        const w = this.rng.float(5, 11);
        const d = this.rng.float(5, 12);
        p.set(point.x + nx * side * dir, h / 2, point.z + nz * side * dir);
        s.set(w, h, d);
        e.set(0, this.rng.float(-0.4, 0.4), 0);
        q.setFromEuler(e);
        m.compose(p, q, s);
        const collider: PropCollider = { x: p.x, y: 0, z: p.z, w: w * 1.05, h, d: d * 1.05, rotY: e.y };
        if (dir > 0) {
          left.push({ geometry: finGeo, matrix: m.clone() });
          leftColliders.push(collider);
        } else {
          right.push({ geometry: finGeo, matrix: m.clone() });
          rightColliders.push(collider);
        }
      }
    }

    // Each side used to bake the combined collider list, registering every fin
    // twice and putting left-side walls on top of right-side meshes.
    for (const [list, mats, name, sideColliders] of [
      [left, rock, 'canyon-left', leftColliders],
      [right, rockDark, 'canyon-right', rightColliders],
    ] as const) {
      const merged = mergeSimpleMeshes(list);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mats);
      mesh.name = name;
      this.disposables.push(merged);
      this.builder.bakeMerged(mesh, sideColliders, true);
    }

    // Rock floor for the corridor so it reads differently from open sand.
    const floorGeo = new THREE.BoxGeometry(24, 0.3, 92);
    this.disposables.push(floorGeo);
    b.box(floorGeo, b.material('canyon-floor', 0x8c6440), -7, 0.15, 15, {
      rotateY: 0.62,
      tags: ['canyon-floor'],
    });

    // Raised ledge along the canyon with a sniper perch.
    const ledgeGeo = new THREE.BoxGeometry(16, 5, 18);
    this.disposables.push(ledgeGeo);
    b.box(ledgeGeo, rockDark, 12, 2.5, 20, { tags: ['ledge'] });
    this.collision.addHeightSample(12, 20, 5, 11);

    // Footbridge across the corridor.
    const deckGeo = new THREE.BoxGeometry(3.2, 0.45, 30);
    const beamGeo = new THREE.BoxGeometry(0.4, 6.5, 0.4);
    this.disposables.push(deckGeo, beamGeo);
    const bx = -14;
    const bz = 8;
    b.box(deckGeo, b.material('bridge', 0x8a7f6d), bx, 5.4, bz, { rotateY: 1.0, tags: ['bridge'] });
    for (const t of [-13, -6.5, 0, 6.5, 13]) {
      b.box(beamGeo, b.material('steel', 0x748096), bx + Math.cos(1.0) * t, 2.6, bz + Math.sin(1.0) * t, {
        tags: ['bridge-beam'],
      });
    }
    // Stamps to walk up onto the bridge at both ends.
    this.collision.addHeightSample(bx + Math.cos(1.0) * 15, bz + Math.sin(1.0) * 15, 5.4, 5.5);
    this.collision.addHeightSample(bx - Math.cos(1.0) * 15, bz - Math.sin(1.0) * 15, 5.4, 5.5);
    this.collision.addHeightSample(bx, bz, 5.6, 12);

    // Waist-high cover rocks inside the corridor.
    const coverGeo = new THREE.IcosahedronGeometry(1.3, 0);
    this.disposables.push(coverGeo);
    const coverMat = b.material('cover-rock', 0x93683f);
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const px = -40 + t * 66 + this.rng.float(-5, 5);
      const pz = 34 - t * 40 + this.rng.float(-5, 5);
      b.decor(coverGeo, coverMat, px, 0.7, pz, { y: this.rng.angle() });
      this.collision.addBox({ x: px, y: 0.75, z: pz }, { x: 2.6, y: 1.5, z: 2.6 }, { tags: ['cover'] });
    }

    this.addSpawns('canyon', [
      { x: -30, z: 26 },
      { x: -18, z: 18 },
      { x: -6, z: 8 },
      { x: 6, z: -2 },
      { x: 16, z: -8 },
      { x: 12, z: 20 },
      { x: -24, z: 30 },
      { x: 2, z: 2 },
    ]);
  }

  // -------------------------------------------------------------- refinery

  private buildRefinery(): void {
    const b = this.builder;
    const cx = this.anchors.refinery.x;
    const cz = this.anchors.refinery.z;
    const steel = b.material('steel', 0x748096);
    const plate = b.material('plate', 0x6b6f78);
    const rust = b.material('cont-a', 0xb5623a);
    const glass = b.material('glass', 0x3f6f8c, { emissive: 0x1c4a63 });

    // Concrete slab.
    const slabGeo = new THREE.BoxGeometry(56, 0.4, 48);
    this.disposables.push(slabGeo);
    b.box(slabGeo, b.material('concrete', 0x8f8b83), cx, 0.2, cz, { tags: ['slab'] });

    // Silos: cylinders the player can circle.
    const siloGeo = new THREE.CylinderGeometry(3.4, 3.6, 13, 12);
    const capGeo = new THREE.SphereGeometry(3.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    this.disposables.push(siloGeo, capGeo);
    for (const [ox, oz] of [[-18, -14], [-9, -16], [-14, -5]]) {
      b.box(siloGeo, plate, cx + ox, 6.5, cz + oz, { tags: ['silo'], radius: 3.6 });
      b.decor(capGeo, plate, cx + ox, 13, cz + oz);
    }

    // Main processing block with an accessible roof.
    const blockGeo = new THREE.BoxGeometry(20, 9, 14);
    const roofCatwalk = new THREE.BoxGeometry(21, 0.4, 3);
    this.disposables.push(blockGeo, roofCatwalk);
    b.box(blockGeo, plate, cx + 6, 4.5, cz + 8, { tags: ['block'] });
    b.box(roofCatwalk, steel, cx + 6, 9.2, cz + 1.6, { tags: ['catwalk'] });
    this.collision.addHeightSample(cx + 6, cz + 8, 9, 13);

    // Stairs to the roof, modelled as ascending height stamps.
    for (let i = 0; i < 9; i++) {
      this.collision.addHeightSample(cx - 5.5 + i * 0.2, cz + 15.5 - i * 1.35, (i + 1) * 1, 2.2);
      const stepGeo = new THREE.BoxGeometry(3.4, 1, 1.4);
      this.disposables.push(stepGeo);
      b.box(stepGeo, steel, cx - 5.5 + i * 0.2, (i + 1) * 1 - 0.5, cz + 15.5 - i * 1.35, { noCollider: true });
    }

    // Pipe runs: horizontal cylinders on trestles.
    const pipeGeo = new THREE.CylinderGeometry(0.55, 0.55, 60, 8);
    pipeGeo.rotateZ(Math.PI / 2);
    const trestleGeo = new THREE.BoxGeometry(0.6, 4.5, 0.6);
    this.disposables.push(pipeGeo, trestleGeo);
    const pipeMat = b.material('pipe', 0x9a8b6a);
    for (const [ox, oz, rot] of [[-4, -22, 0], [10, 18, 0.35], [-22, 6, 1.2]] as const) {
      b.decor(pipeGeo, pipeMat, cx + ox, 4.8, cz + oz, { y: rot });
      this.collision.addBox(
        { x: cx + ox, y: 4.8, z: cz + oz },
        { x: rot === 0 ? 58 : 10, y: 1.2, z: rot === 0 ? 10 : 58 },
        { tags: ['pipe'], solid: false },
      );
      for (const t of [-22, -8, 6, 20]) {
        b.box(trestleGeo, steel, cx + ox + (rot === 0 ? t : 0), 2.25, cz + oz + (rot === 0 ? 0 : t), {
          tags: ['trestle'],
        });
      }
    }

    // Conveyor gantry with a glowing intake. Carries the belt at head height: at
    // 1.8 m the underside was a wall the player could not walk under, and it sat
    // across the route out of the canyon.
    const gantryGeo = new THREE.BoxGeometry(4, 1.2, 26);
    const gantryLegGeo = new THREE.BoxGeometry(0.6, 3.8, 0.6);
    const intakeGeo = new THREE.CylinderGeometry(2.2, 2.9, 3, 10);
    this.disposables.push(gantryGeo, gantryLegGeo, intakeGeo);
    b.box(gantryGeo, b.material('belt', 0x4b4238), cx - 8, 4.4, cz + 6, { rotateY: 0.9, tags: ['gantry'] });
    const gcos = Math.cos(0.9);
    const gsin = Math.sin(0.9);
    for (const t of [-10, 0, 10]) {
      b.box(gantryLegGeo, steel, cx - 8 + gcos * t, 1.9, cz + 6 + gsin * t, { tags: ['gantry-leg'] });
    }
    b.box(intakeGeo, rust, cx - 16, 1.5, cz + 12, { tags: ['intake'], radius: 2.9 });
    const intakeRing = new THREE.TorusGeometry(2.3, 0.3, 6, 16);
    intakeRing.rotateX(Math.PI / 2);
    this.disposables.push(intakeRing);
    b.decor(intakeRing, glass, cx - 16, 3.2, cz + 12);

    // Containers and hazard piles for cover.
    const containerGeo = new THREE.BoxGeometry(6.1, 2.7, 2.5);
    const stackGeo = new THREE.BoxGeometry(3, 3, 3);
    this.disposables.push(containerGeo, stackGeo);
    const mats = [rust, b.material('cont-b', 0x4e7f8c), b.material('cont-c', 0x8d8141)];
    const spots: [number, number, number][] = [
      [-20, 16, 0.2],
      [18, -14, 1.5],
      [22, -8, 1.5],
      [-6, -18, 0],
      [8, -6, 0.8],
      [-24, -10, 1.1],
    ];
    for (const [ox, oz, rot] of spots) {
      const mi = this.rng.int(0, 2);
      b.box(containerGeo, mats[mi] as THREE.Material, cx + ox, 1.35, cz + oz, {
        rotateY: rot,
        tags: ['container'],
      });
      if (this.rng.bool(0.5)) {
        b.box(containerGeo, mats[(mi + 1) % 3] as THREE.Material, cx + ox, 4.1, cz + oz, {
          rotateY: rot + 0.05,
          tags: ['container'],
        });
      }
    }
    for (let i = 0; i < 8; i++) {
      const a = this.rng.angle();
      const r = this.rng.float(12, 26);
      b.box(stackGeo, b.material('hazard', 0x7a6b45), cx + Math.cos(a) * r, 1.5, cz + Math.sin(a) * r, {
        rotateY: this.rng.angle(),
        tags: ['hazard'],
      });
    }

    // Flood lights: emissive only, no dynamic lights, to protect the frame rate.
    const mastGeo = new THREE.BoxGeometry(0.4, 9, 0.4);
    const headGeo = new THREE.BoxGeometry(1.6, 0.8, 0.8);
    this.disposables.push(mastGeo, headGeo);
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffcf7a, fog: false });
    this.beacons.push(beaconMat);
    for (const [ox, oz] of [[-24, -20], [24, 20], [24, -20], [-24, 20]] as const) {
      b.box(mastGeo, steel, cx + ox, 4.5, cz + oz, { tags: ['mast'] });
      b.decor(headGeo, beaconMat, cx + ox, 9.1, cz + oz, { y: Math.atan2(-oz, -ox) });
    }

    this.addSpawns('refinery', [
      { x: cx - 14, z: cz + 2 },
      { x: cx + 14, z: cz - 4 },
      { x: cx + 2, z: cz - 14 },
      { x: cx - 4, z: cz + 16 },
      { x: cx + 20, z: cz + 10 },
      { x: cx - 20, z: cz - 16 },
      { x: cx + 10, z: cz + 14 },
    ]);
  }

  // ----------------------------------------------------------------- arena

  private buildArena(): void {
    const b = this.builder;
    const cx = this.anchors.bossArena.x;
    const cz = this.anchors.bossArena.z;
    const steel = b.material('steel', 0x748096);
    const hazardMat = b.material('arena-hazard', 0x8c3f2a, { emissive: 0x5c2214, emissiveIntensity: 0.6 });

    // Octagonal platform with a raised lip.
    const floorGeo = new THREE.CylinderGeometry(27, 27, 0.6, 8);
    this.disposables.push(floorGeo);
    b.box(floorGeo, b.material('arena-floor', 0x7d7365), cx, 0.3, cz, { tags: ['arena-floor'] });
    this.collision.addHeightSample(cx, cz, 0.6, 26);

    const lipGeo = new THREE.CylinderGeometry(28.6, 29.2, 1.1, 8);
    this.disposables.push(lipGeo);
    b.decor(lipGeo, hazardMat, cx, 1.05, cz);
    this.collision.addRawBox({
      minX: cx - 29.4,
      maxX: cx + 29.4,
      minY: 0.6,
      maxY: 1.0,
      minZ: cz - 29.4,
      maxZ: cz + 29.4,
      topY: 0.6,
      // Leave the interior walkable: the lip is decorative except for its ring.
      solid: false,
      tags: ['arena-lip'],
    });

    // Entrance ramp from the refinery side.
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      this.collision.addHeightSample(cx - 34 + t * 8, cz + 34 - t * 8, 0.6 * t, 3.2);
    }

    // Four corner blocks: cover that the player can jump onto.
    const blockGeo = new THREE.BoxGeometry(6, 3.4, 6);
    this.disposables.push(blockGeo);
    for (const [ox, oz] of [[-15, -15], [15, -15], [-15, 15], [15, 15]] as const) {
      b.box(blockGeo, steel, cx + ox, 1.7, cz + oz, { rotateY: 0.4, tags: ['arena-block'] });
      this.collision.addHeightSample(cx + ox, cz + oz, 3.4, 4.2);
    }

    // Central pedestal that holds the quest reward.
    const pedGeo = new THREE.CylinderGeometry(1.6, 2.1, 1.35, 8);
    this.disposables.push(pedGeo);
    b.box(pedGeo, b.material('pedestal', 0x9aa4b4), cx, 0.68, cz, { tags: ['pedestal'], radius: 2.1 });

    // Broken machinery around the rim for silhouette interest.
    const armGeo = new THREE.BoxGeometry(1.1, 7, 1.1);
    this.disposables.push(armGeo);
    const armMat = b.material('rust-mach', 0x8a5a34);
    for (let i = 0; i < 10; i++) {
      const a = this.rng.angle();
      const r = this.rng.float(20, 26);
      b.decor(armGeo, armMat, cx + Math.cos(a) * r, 2.6, cz + Math.sin(a) * r, {
        z: this.rng.float(-0.5, 0.5),
        x: this.rng.float(-0.4, 0.4),
        y: a,
      });
    }

    this.addSpawns('arena', [
      { x: cx - 18, z: cz - 6 },
      { x: cx + 18, z: cz + 6 },
      { x: cx, z: cz + 20 },
    ]);
  }

  // --------------------------------------------------------------- debris

  /** Scattered rocks, barrels and bones across the open sand. */
  private scatterDebris(): void {
    const b = this.builder;
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const barrelGeo = new THREE.CylinderGeometry(0.6, 0.6, 1.5, 8);
    this.disposables.push(rockGeo, barrelGeo);
    const rockMat = b.material('pebble', 0x9a7048);
    const barrelMat = b.material('barrel', 0x9c5b2e);

    const rockEntries: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const barrelEntries: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
    const colliders: { x: number; y: number; z: number; w: number; h: number; d: number; rotY?: number; radius?: number }[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    const nearAnchor = (x: number, z: number, pad: number): boolean =>
      this.zones.some((zone) => {
        const dx = x - zone.center.x;
        const dz = z - zone.center.z;
        return dx * dx + dz * dz < (zone.radius + pad) * (zone.radius + pad);
      });

    for (let i = 0; i < 190; i++) {
      const x = this.rng.float(-140, 140);
      const z = this.rng.float(-140, 140);
      if (nearAnchor(x, z, 4)) continue;
      const scale = this.rng.float(0.5, 2.4);
      p.set(x, scale * 0.35, z);
      s.set(scale * this.rng.float(1, 1.6), scale, scale * this.rng.float(1, 1.6));
      e.set(this.rng.float(-0.4, 0.4), this.rng.angle(), this.rng.float(-0.4, 0.4));
      q.setFromEuler(e);
      m.compose(p, q, s);
      rockEntries.push({ geometry: rockGeo, matrix: m.clone() });
      if (scale > 1.3) {
        colliders.push({ x, y: 0, z, w: s.x * 1.4, h: s.y * 1.2, d: s.z * 1.4, rotY: e.y });
      }
    }

    const barrelColliders: typeof colliders = [];
    for (let i = 0; i < 46; i++) {
      const x = this.rng.float(-135, 135);
      const z = this.rng.float(-135, 135);
      if (nearAnchor(x, z, 6)) continue;
      p.set(x, 0.75, z);
      q.setFromEuler(e.set(this.rng.bool(0.25) ? Math.PI / 2 : 0, this.rng.angle(), 0));
      s.set(1, 1, 1);
      m.compose(p, q, s);
      barrelEntries.push({ geometry: barrelGeo, matrix: m.clone() });
      // Round footprint: a barrel is drawn as a cylinder, so it must not collide
      // as a 1.4 m square that corners the player against invisible faces.
      barrelColliders.push({ x, y: 0, z, w: 1.4, h: 1.6, d: 1.4, radius: 0.62 });
    }

    const rocks = mergeSimpleMeshes(rockEntries);
    if (rocks) {
      this.disposables.push(rocks);
      this.builder.bakeMerged(new THREE.Mesh(rocks, rockMat), colliders, true);
    }
    const barrels = mergeSimpleMeshes(barrelEntries);
    if (barrels) {
      this.disposables.push(barrels);
      this.builder.bakeMerged(new THREE.Mesh(barrels, barrelMat), barrelColliders, true);
    }
  }

  // ----------------------------------------------------------------- frame

  update(dt: number): void {
    this.time += dt;
    for (const spinner of this.spinners) {
      if (spinner.speed !== 0) spinner.mesh.rotation.y += dt * spinner.speed;
    }
    const pulse = 0.55 + Math.sin(this.time * 2.2) * 0.35;
    for (const beacon of this.beacons) beacon.color.setRGB(1, 0.8 * pulse + 0.2, 0.42 * pulse);
  }

  dispose(): void {
    this.scene.remove(this.group);
    if (this.sky) this.scene.remove(this.sky);
    this.builder.dispose();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.spinners.length = 0;
    this.beacons.length = 0;
    this.group.clear();
  }
}

/** Control points for the canyon corridor, camp end to refinery gate. */
export function canyonPath(): { x: number; z: number }[] {
  const control: [number, number][] = [
    [-42, 36],
    [-26, 26],
    [-8, 14],
    [8, 2],
    [24, -10],
  ];
  const out: { x: number; z: number }[] = [];
  const segments = 14;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = catmullRom(control, t);
    out.push(p);
  }
  return out;
}

function catmullRom(points: [number, number][], t: number): { x: number; z: number } {
  const n = points.length - 1;
  const scaled = Math.min(Math.max(t, 0), 1) * n;
  const i = Math.min(Math.floor(scaled), n - 1);
  const local = scaled - i;
  const p0 = points[Math.max(i - 1, 0)] as [number, number];
  const p1 = points[i] as [number, number];
  const p2 = points[Math.min(i + 1, n)] as [number, number];
  const p3 = points[Math.min(i + 2, n)] as [number, number];
  const lerpAxis = (a: number, b: number, c: number, d: number): number => {
    const t2 = local;
    const t3 = t2 * t2;
    const t4 = t3 * t2;
    return (
      0.5 *
      (2 * b + (c - a) * t2 + (2 * a - 5 * b + 4 * c - d) * t3 + (3 * b - a - 3 * c + d) * t4)
    );
  };
  return {
    x: lerpAxis(p0[0], p1[0], p2[0], p3[0]),
    z: lerpAxis(p0[1], p1[1], p2[1], p3[1]),
  };
}

function tangentAt(path: { x: number; z: number }[], index: number): { x: number; z: number } {
  const a = path[Math.max(index - 1, 0)] as { x: number; z: number };
  const b = path[Math.min(index + 1, path.length - 1)] as { x: number; z: number };
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}
