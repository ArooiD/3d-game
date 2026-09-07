import * as THREE from 'three';
import { RARITY_HEX } from '../../../shared/constants';
import type { Weapon } from '../../../shared/types';
import { buildGunModel, fitGunLength } from '../weapons/WeaponModels';
import { rng } from '../core/Rng';
import { bus, GameEvents } from '../core/EventBus';
import type { EnemyPartId, EnemyPartVisualSeverity } from '../enemies/EnemyParts';

/**
 * Pooled visual effects: impact sparks, muzzle flashes, tracers, explosion
 * rings, floating damage numbers and loot beams. Everything is allocated up
 * front and recycled, so ordinary combat produces no GC pressure. Rare enemy
 * limb breaks are allowed to clone a few existing meshes for short-lived debris.
 */

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  spin: THREE.Vector3;
  active: boolean;
  fadeScale: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  active: boolean;
}

interface Popup {
  el: HTMLDivElement;
  world: THREE.Vector3;
  life: number;
  maxLife: number;
  rise: number;
  active: boolean;
}

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  maxRadius: number;
  active: boolean;
}

interface EnemyPartVisualEvent {
  id: string;
  part: EnemyPartId;
  severity: EnemyPartVisualSeverity;
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  isBoss: boolean;
  height: number;
  groundY: number;
}

interface DetachedEnemyPart {
  group: THREE.Group;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  groundY: number;
  landed: boolean;
}

interface DamageSparkEmitter {
  owner: THREE.Object3D;
  anchor: THREE.Object3D;
  cooldown: number;
  life: number;
  strength: number;
}

interface DamageAttachment {
  owner: THREE.Object3D;
  part: EnemyPartId;
  mesh: THREE.Mesh;
}

const PARTICLE_POOL = 340;
const TRACER_POOL = 40;
const POPUP_POOL = 60;
const RING_POOL = 12;
const FLASH_POOL = 6;

export class EffectsSystem {
  readonly group = new THREE.Group();
  private particles: Particle[] = [];
  private tracers: Tracer[] = [];
  private popups: Popup[] = [];
  private rings: Ring[] = [];
  private flashes: { mesh: THREE.Mesh; light: THREE.PointLight | null; life: number; maxLife: number }[] = [];
  private detachedEnemyParts: DetachedEnemyPart[] = [];
  private damageSparkEmitters: DamageSparkEmitter[] = [];
  private damageAttachments: DamageAttachment[] = [];
  private particleGeo: THREE.BufferGeometry;
  private tracerGeo: THREE.BufferGeometry;
  private ringGeo: THREE.BufferGeometry;
  private flashGeo: THREE.BufferGeometry;
  private damageSocketGeo: THREE.BufferGeometry;
  private damageRingGeo: THREE.BufferGeometry;
  private damagePatchGeo: THREE.BufferGeometry;
  private damageOuterMat: THREE.MeshLambertMaterial;
  private damageInnerMat: THREE.MeshLambertMaterial;
  private materials: THREE.Material[] = [];
  private overlay: HTMLElement;
  private camera: THREE.Camera | null = null;
  private pooledCount = 0;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private scratch = new THREE.Vector3();

  /** Dynamic lights are strictly capped; only the two most recent flashes get one. */
  useDynamicLights = true;

  constructor(scene: THREE.Scene, overlay: HTMLElement) {
    this.group.name = 'effects';
    scene.add(this.group);
    this.overlay = overlay;

    this.particleGeo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
    this.tracerGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 26);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.flashGeo = new THREE.IcosahedronGeometry(0.34, 0);

    // Shared visual-damage geometry. These attachments live on enemy bones but
    // reference resources owned here, so losing limbs does not allocate a fresh
    // material/geometry pair for every actor.
    this.damageSocketGeo = new THREE.CylinderGeometry(0.5, 0.42, 1, 18);
    this.damageRingGeo = new THREE.TorusGeometry(0.5, 0.14, 8, 20);
    this.damageRingGeo.rotateX(Math.PI / 2);
    this.damagePatchGeo = new THREE.BoxGeometry(1, 1, 1);
    this.damageOuterMat = new THREE.MeshLambertMaterial({ color: 0x24262c, emissive: 0x120d0a });
    this.damageInnerMat = new THREE.MeshLambertMaterial({ color: 0x6c3229, emissive: 0x220b06 });
    this.materials.push(this.damageOuterMat, this.damageInnerMat);

    this.buildPools();
    bus.on<EnemyPartVisualEvent>(GameEvents.EnemyPartVisual, this.onEnemyPartVisual, this);
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  private buildPools(): void {
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, fog: false });
    const bloodMat = new THREE.MeshBasicMaterial({ color: 0xff7a4a, transparent: true, fog: false });
    const shieldMat = new THREE.MeshBasicMaterial({ color: 0x8ecbff, transparent: true, fog: false });
    const debrisMat = new THREE.MeshBasicMaterial({ color: 0x9a8a72, transparent: true, fog: false });
    this.materials.push(sparkMat, bloodMat, shieldMat, debrisMat);

    const particleMats = [sparkMat, bloodMat, shieldMat, debrisMat];
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const mesh = new THREE.Mesh(this.particleGeo, particleMats[i % particleMats.length] as THREE.Material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.particles.push({
        mesh,
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        gravity: 12,
        spin: new THREE.Vector3(),
        active: false,
        fadeScale: 1,
      });
    }

    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.9, fog: false });
    this.materials.push(tracerMat);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(this.tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0, maxLife: 0.06, active: false });
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb066,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.materials.push(ringMat);
    for (let i = 0; i < RING_POOL; i++) {
      const mesh = new THREE.Mesh(this.ringGeo, ringMat.clone());
      this.materials.push(mesh.material as THREE.Material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.5, maxRadius: 6, active: false });
    }

    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, fog: false });
    this.materials.push(flashMat);
    for (let i = 0; i < FLASH_POOL; i++) {
      const mesh = new THREE.Mesh(this.flashGeo, flashMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      // Only two pooled muzzle flashes ever own a real light.
      const light = i < 2 && this.useDynamicLights ? new THREE.PointLight(0xffcc80, 0, 14, 2) : null;
      if (light) {
        light.visible = false;
        this.group.add(light);
      }
      this.flashes.push({ mesh, light, life: 0, maxLife: 0.06 });
    }

    for (let i = 0; i < POPUP_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'dmg hidden';
      this.overlay.appendChild(el);
      this.popups.push({ el, world: new THREE.Vector3(), life: 0, maxLife: 0.9, rise: 1, active: false });
    }

    this.pooledCount =
      PARTICLE_POOL + TRACER_POOL + POPUP_POOL + RING_POOL + FLASH_POOL;
  }

  get pooledObjects(): number {
    return this.pooledCount;
  }

  // ------------------------------------------------------------- emitters

  private takeParticle(): Particle | null {
    for (const p of this.particles) {
      if (!p.active) return p;
    }
    // Reuse the oldest when saturated rather than dropping the effect.
    let oldest = this.particles[0] as Particle;
    for (const p of this.particles) {
      if (p.life < oldest.life) oldest = p;
    }
    return oldest;
  }

  burst(
    position: THREE.Vector3,
    options: {
      count?: number;
      color?: 'spark' | 'blood' | 'shield' | 'debris';
      speed?: number;
      spread?: number;
      life?: number;
      gravity?: number;
      size?: number;
      upward?: number;
    } = {},
  ): void {
    const count = options.count ?? 10;
    const speed = options.speed ?? 6;
    const life = options.life ?? 0.5;
    const size = options.size ?? 1;
    const upward = options.upward ?? 0.6;
    for (let i = 0; i < count; i++) {
      const p = this.takeParticle();
      if (!p) return;
      p.active = true;
      p.mesh.visible = true;
      p.mesh.position.copy(position);
      p.mesh.scale.setScalar(size * rng.float(0.6, 1.5));
      const theta = rng.angle();
      const phi = Math.acos(rng.float(-1, 1));
      const s = speed * rng.float(0.35, 1);
      p.velocity.set(
        Math.sin(phi) * Math.cos(theta) * s,
        Math.abs(Math.cos(phi)) * s * upward + rng.float(0.5, 2),
        Math.sin(phi) * Math.sin(theta) * s,
      );
      p.spin.set(rng.float(-12, 12), rng.float(-12, 12), rng.float(-12, 12));
      p.maxLife = life * rng.float(0.7, 1.3);
      p.life = p.maxLife;
      p.gravity = options.gravity ?? 14;
      p.fadeScale = size;
      const mat = p.mesh.material as THREE.Material;
      const wanted =
        options.color === 'blood'
          ? 0xff7a4a
          : options.color === 'shield'
            ? 0x8ecbff
            : options.color === 'debris'
              ? 0x9a8a72
              : 0xffd08a;
      (mat as THREE.MeshBasicMaterial).color.setHex(wanted);
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, colorHex?: number, width = 1): void {
    let tracer = this.tracers.find((t) => !t.active);
    if (!tracer) tracer = this.tracers[0] as Tracer;
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 0.01) return;
    tracer.active = true;
    tracer.maxLife = 0.055;
    tracer.life = tracer.maxLife;
    const mesh = tracer.mesh;
    mesh.visible = true;
    mesh.position.copy(from).addScaledVector(dir, 0.5);
    mesh.lookAt(to);
    mesh.scale.set(width, width, len);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.95;
    if (colorHex !== undefined) mat.color.setHex(colorHex);
  }

  muzzleFlash(position: THREE.Vector3, direction: THREE.Vector3, scale = 1): void {
    let flash = this.flashes.find((f) => f.life <= 0);
    if (!flash) flash = this.flashes[0] as { mesh: THREE.Mesh; light: THREE.PointLight | null; life: number; maxLife: number };
    flash.life = 0.055;
    flash.maxLife = 0.055;
    flash.mesh.visible = true;
    flash.mesh.position.copy(position).addScaledVector(direction, 0.35);
    flash.mesh.scale.setScalar(scale * rng.float(0.85, 1.2));
    flash.mesh.rotation.set(rng.angle(), rng.angle(), rng.angle());
    if (flash.light) {
      flash.light.visible = true;
      flash.light.position.copy(flash.mesh.position);
      flash.light.intensity = 9 * scale;
      flash.light.distance = 11 * scale;
    }
  }

  ring(position: THREE.Vector3, maxRadius: number, colorHex: number, life = 0.5): void {
    let ring = this.rings.find((r) => !r.active);
    if (!ring) ring = this.rings[0] as Ring;
    ring.active = true;
    ring.maxRadius = maxRadius;
    ring.maxLife = life;
    ring.life = life;
    ring.mesh.visible = true;
    ring.mesh.position.copy(position);
    (ring.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
    (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    ring.mesh.scale.setScalar(0.001);
  }

  /** Floating combat text. `kind` selects the CSS variant. */
  damageNumber(
    worldPosition: THREE.Vector3,
    text: string,
    kind: 'normal' | 'crit' | 'shield' | 'player' = 'normal',
  ): void {
    let popup = this.popups.find((p) => !p.active);
    if (!popup) popup = this.popups[0] as Popup;
    popup.active = true;
    popup.world.copy(worldPosition);
    popup.maxLife = kind === 'crit' ? 1.15 : 0.85;
    popup.life = popup.maxLife;
    popup.rise = rng.float(0.9, 1.6);
    popup.el.className = `dmg ${kind === 'crit' ? 'crit' : kind === 'shield' ? 'shield' : kind === 'player' ? 'player' : ''}`;
    popup.el.textContent = text;
    popup.el.style.opacity = '1';
    // Small lateral scatter so stacked numbers stay readable.
    popup.world.x += rng.float(-0.35, 0.35);
    popup.world.y += rng.float(-0.15, 0.35);
  }

  // ------------------------------------------------------ composite helpers

  impactHit(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.burst(point, { count: 6, color: 'spark', speed: 5, life: 0.32, size: 0.7 });
    const offset = normal.clone().multiplyScalar(0.06);
    this.burst(point.clone().add(offset), { count: 3, color: 'debris', speed: 3, life: 0.5, size: 0.8 });
  }

  fleshHit(point: THREE.Vector3, critical: boolean): void {
    this.burst(point, {
      count: critical ? 16 : 9,
      color: 'blood',
      speed: critical ? 8 : 5,
      life: 0.45,
      size: critical ? 1.2 : 0.9,
    });
  }

  shieldHit(point: THREE.Vector3): void {
    this.burst(point, { count: 10, color: 'shield', speed: 6, life: 0.35, size: 0.8, gravity: 4 });
  }

  explosion(point: THREE.Vector3, radius: number): void {
    this.burst(point, { count: 26, color: 'spark', speed: radius * 1.6, life: 0.6, size: 1.5, gravity: 8 });
    this.burst(point, { count: 14, color: 'debris', speed: radius, life: 0.9, size: 1.3 });
    this.ring(point.clone().setY(point.y + 0.15), radius, 0xffa04a, 0.55);
  }

  // ---------------------------------------------------- enemy visual damage

  private readonly onEnemyPartVisual = (payload: EnemyPartVisualEvent): void => {
    if (!payload?.root || !payload.part) return;
    payload.root.updateWorldMatrix(true, true);
    const point = this.damagePoint(payload);

    if (payload.severity === 'damaged') {
      if (payload.part === 'weapon') {
        this.burst(point, { count: 5, color: 'spark', speed: 4, life: 0.35, gravity: 7, size: 0.55 });
        this.startWeaponSparks(payload, 0.55);
        this.attachDamagePatch(payload);
      } else if (payload.part === 'head') {
        this.burst(point, { count: 4, color: 'debris', speed: 3, life: 0.45, size: 0.55 });
        this.burst(point, { count: 3, color: 'blood', speed: 2.5, life: 0.35, size: 0.5 });
        this.attachDamagePatch(payload);
      } else if (payload.part !== 'torso') {
        this.burst(point, { count: 4, color: 'blood', speed: 3.2, life: 0.34, size: 0.55 });
        this.burst(point, { count: 2, color: 'debris', speed: 2.4, life: 0.45, size: 0.45 });
      }
      return;
    }

    if (payload.part === 'weapon') {
      this.burst(point, { count: 12, color: 'spark', speed: 6.5, life: 0.55, gravity: 7, size: 0.8 });
      this.burst(point, { count: 5, color: 'debris', speed: 4, life: 0.65, size: 0.65 });
      this.startWeaponSparks(payload, 1.25);
      this.attachDamagePatch(payload);
      return;
    }

    if (payload.part === 'head') {
      this.burst(point, { count: 8, color: 'debris', speed: 4.5, life: 0.65, size: 0.75 });
      this.burst(point, { count: 7, color: 'blood', speed: 5.5, life: 0.5, size: 0.75 });
      this.attachDamagePatch(payload);
      return;
    }

    if (payload.part === 'armR') {
      // The ranged weapon is parented to the right forearm. Once that arm leaves
      // the body any previous damaged-gun spark emitter must leave with it rather
      // than hovering in front of an invisible hand.
      this.damageSparkEmitters = this.damageSparkEmitters.filter((emitter) => emitter.owner !== payload.root);
    }

    if (payload.part === 'armL' || payload.part === 'armR' || payload.part === 'legL' || payload.part === 'legR') {
      this.burst(point, { count: 13, color: 'blood', speed: 6.5, life: 0.55, size: 0.9 });
      this.burst(point, { count: 7, color: 'debris', speed: 5, life: 0.75, size: 0.75 });
      this.spawnDetachedEnemyPart(payload);
      this.attachDamageSocket(payload);
    }
  };

  private damagePoint(payload: EnemyPartVisualEvent): THREE.Vector3 {
    const anchor = this.damageAnchor(payload);
    const point = new THREE.Vector3();
    if (anchor) anchor.getWorldPosition(point);
    else payload.root.getWorldPosition(point);
    if (payload.part === 'head') point.y += payload.height * 0.07;
    return point;
  }

  private damageAnchor(payload: EnemyPartVisualEvent): THREE.Object3D | undefined {
    switch (payload.part) {
      case 'head':
        return payload.root.getObjectByName('head');
      case 'armL':
        return payload.root.getObjectByName('armL');
      case 'armR':
        return payload.root.getObjectByName('armR');
      case 'legL':
        return payload.root.getObjectByName('thighL');
      case 'legR':
        return payload.root.getObjectByName('thighR');
      case 'weapon':
        return payload.root.getObjectByName('muzzle') ?? payload.root.getObjectByName('forearmR');
      default:
        return payload.root.getObjectByName('chest');
    }
  }

  private spawnDetachedEnemyPart(payload: EnemyPartVisualEvent): void {
    const source = payload.meshes.filter((mesh) => mesh.visible && mesh.geometry);
    if (source.length === 0) return;

    const center = new THREE.Vector3();
    const world = new THREE.Vector3();
    for (const mesh of source) {
      mesh.updateWorldMatrix(true, false);
      center.add(world.setFromMatrixPosition(mesh.matrixWorld));
    }
    center.multiplyScalar(1 / source.length);

    const detached = new THREE.Group();
    detached.name = `detached-${payload.id}-${payload.part}`;
    this.group.updateWorldMatrix(true, false);
    detached.position.copy(center);
    this.group.worldToLocal(detached.position);
    this.group.add(detached);
    detached.updateWorldMatrix(true, false);

    const inverse = detached.matrixWorld.clone().invert();
    const local = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const mesh of source) {
      local.multiplyMatrices(inverse, mesh.matrixWorld);
      local.decompose(pos, quat, scale);
      const clone = new THREE.Mesh(mesh.geometry, mesh.material);
      clone.position.copy(pos);
      clone.quaternion.copy(quat);
      clone.scale.copy(scale);
      clone.castShadow = true;
      clone.receiveShadow = false;
      detached.add(clone);
    }

    const side = payload.part.endsWith('L') ? -1 : payload.part.endsWith('R') ? 1 : rng.bool() ? 1 : -1;
    const actorRotation = payload.root.getWorldQuaternion(new THREE.Quaternion());
    const sideVector = new THREE.Vector3(side, 0, 0).applyQuaternion(actorRotation).normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(actorRotation).normalize();
    const leg = payload.part === 'legL' || payload.part === 'legR';
    const velocity = sideVector.multiplyScalar(leg ? 2.2 : 3.4)
      .addScaledVector(forward, rng.float(-1.4, 1.4));
    velocity.y += leg ? rng.float(2.8, 4.0) : rng.float(4.1, 5.8);

    this.detachedEnemyParts.push({
      group: detached,
      velocity,
      spin: new THREE.Vector3(rng.float(-7, 7), rng.float(-7, 7), rng.float(-7, 7)),
      life: rng.float(3.6, 4.8),
      groundY: payload.groundY + 0.06,
      landed: false,
    });
  }

  private attachDamageSocket(payload: EnemyPartVisualEvent): void {
    if (payload.isBoss) return;
    const anchor = this.damageAnchor(payload);
    if (!anchor) return;
    if (this.damageAttachments.some((entry) => entry.owner === payload.root && entry.part === payload.part)) return;

    const leg = payload.part === 'legL' || payload.part === 'legR';
    const radius = payload.height * (leg ? 0.055 : 0.042);
    const depth = payload.height * (leg ? 0.032 : 0.026);

    const socket = new THREE.Mesh(this.damageSocketGeo, this.damageInnerMat);
    socket.scale.set(radius * 2, depth, radius * 2);
    socket.position.y = -depth * 0.2;
    socket.castShadow = true;
    anchor.add(socket);

    const collar = new THREE.Mesh(this.damageRingGeo, this.damageOuterMat);
    collar.scale.setScalar(radius * 2.25);
    collar.position.y = -depth * 0.05;
    collar.castShadow = true;
    anchor.add(collar);

    this.damageAttachments.push(
      { owner: payload.root, part: payload.part, mesh: socket },
      { owner: payload.root, part: payload.part, mesh: collar },
    );
  }

  private attachDamagePatch(payload: EnemyPartVisualEvent): void {
    const anchor = this.damageAnchor(payload);
    if (!anchor) return;
    if (this.damageAttachments.some((entry) => entry.owner === payload.root && entry.part === payload.part)) return;

    const patch = new THREE.Mesh(this.damagePatchGeo, this.damageOuterMat);
    patch.castShadow = true;
    if (payload.part === 'head') {
      patch.position.set(0, payload.height * 0.075, -payload.height * 0.062);
      patch.scale.set(payload.height * 0.055, payload.height * 0.017, payload.height * 0.009);
      patch.rotation.z = 0.18;
    } else {
      // Muzzle anchor faces along -Z; move the scorch block back toward the gun.
      patch.position.set(0, 0, payload.height * 0.065);
      patch.scale.set(payload.height * 0.024, payload.height * 0.018, payload.height * 0.055);
      patch.rotation.z = -0.12;
    }
    anchor.add(patch);
    this.damageAttachments.push({ owner: payload.root, part: payload.part, mesh: patch });
  }

  private startWeaponSparks(payload: EnemyPartVisualEvent, strength: number): void {
    const anchor = payload.root.getObjectByName('muzzle') ?? payload.root.getObjectByName('forearmR');
    if (!anchor) return;
    const existing = this.damageSparkEmitters.find((emitter) => emitter.owner === payload.root);
    if (existing) {
      existing.anchor = anchor;
      existing.strength = Math.max(existing.strength, strength);
      existing.life = Math.max(existing.life, strength > 1 ? 20 : 11);
      existing.cooldown = 0;
      return;
    }
    this.damageSparkEmitters.push({
      owner: payload.root,
      anchor,
      cooldown: 0,
      life: strength > 1 ? 20 : 11,
      strength,
    });
  }

  // ------------------------------------------------------------------ frame

  update(dt: number): void {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.velocity.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      const t = p.life / p.maxLife;
      p.mesh.scale.setScalar(Math.max(0.001, p.fadeScale * t * 1.1));
    }

    for (const t of this.tracers) {
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        t.mesh.visible = false;
        continue;
      }
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = (t.life / t.maxLife) * 0.9;
    }

    for (const ring of this.rings) {
      if (!ring.active) continue;
      ring.life -= dt;
      if (ring.life <= 0) {
        ring.active = false;
        ring.mesh.visible = false;
        continue;
      }
      const t = 1 - ring.life / ring.maxLife;
      ring.mesh.scale.setScalar(Math.max(0.001, ring.maxRadius * t));
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
    }

    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt;
      if (flash.life <= 0) {
        flash.mesh.visible = false;
        if (flash.light) {
          flash.light.visible = false;
          flash.light.intensity = 0;
        }
        continue;
      }
      const t = flash.life / flash.maxLife;
      (flash.mesh.material as THREE.MeshBasicMaterial).opacity = t;
      if (flash.light) flash.light.intensity = 9 * t;
    }

    this.updateDetachedEnemyParts(dt);
    this.updateDamageSparkEmitters(dt);
    this.pruneDamageAttachments();
    this.updatePopups(dt);
  }

  private updateDetachedEnemyParts(dt: number): void {
    for (let i = this.detachedEnemyParts.length - 1; i >= 0; i--) {
      const piece = this.detachedEnemyParts[i]!;
      piece.life -= dt;
      if (piece.life <= 0) {
        piece.group.removeFromParent();
        piece.group.clear();
        this.detachedEnemyParts.splice(i, 1);
        continue;
      }

      if (!piece.landed) {
        piece.velocity.y -= 17 * dt;
        piece.group.position.addScaledVector(piece.velocity, dt);
        piece.group.rotation.x += piece.spin.x * dt;
        piece.group.rotation.y += piece.spin.y * dt;
        piece.group.rotation.z += piece.spin.z * dt;

        if (piece.group.position.y <= piece.groundY) {
          piece.group.position.y = piece.groundY;
          if (Math.abs(piece.velocity.y) > 1.3) {
            piece.velocity.y = Math.abs(piece.velocity.y) * 0.24;
            piece.velocity.x *= 0.62;
            piece.velocity.z *= 0.62;
            piece.spin.multiplyScalar(0.68);
          } else {
            piece.velocity.set(0, 0, 0);
            piece.spin.set(0, 0, 0);
            piece.landed = true;
          }
        }
      }
    }
  }

  private updateDamageSparkEmitters(dt: number): void {
    for (let i = this.damageSparkEmitters.length - 1; i >= 0; i--) {
      const emitter = this.damageSparkEmitters[i]!;
      emitter.life -= dt;
      if (emitter.life <= 0 || emitter.owner.parent === null) {
        this.damageSparkEmitters.splice(i, 1);
        continue;
      }

      emitter.cooldown -= dt;
      if (emitter.cooldown > 0) continue;
      emitter.anchor.getWorldPosition(this.scratch);
      const strong = emitter.strength > 1;
      this.burst(this.scratch, {
        count: strong ? 4 : 2,
        color: 'spark',
        speed: strong ? 4.5 : 2.8,
        life: strong ? 0.42 : 0.3,
        gravity: 6,
        size: strong ? 0.62 : 0.42,
      });
      emitter.cooldown = rng.float(strong ? 0.1 : 0.22, strong ? 0.24 : 0.48);
    }
  }

  private pruneDamageAttachments(): void {
    for (let i = this.damageAttachments.length - 1; i >= 0; i--) {
      const attachment = this.damageAttachments[i]!;
      if (attachment.owner.parent !== null) continue;
      attachment.mesh.removeFromParent();
      this.damageAttachments.splice(i, 1);
    }
  }

  private updatePopups(dt: number): void {
    const camera = this.camera;
    if (!camera) return;
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const width = window.innerWidth;
    const height = window.innerHeight;

    for (const popup of this.popups) {
      if (!popup.active) continue;
      popup.life -= dt;
      if (popup.life <= 0) {
        popup.active = false;
        popup.el.className = 'dmg hidden';
        continue;
      }
      popup.world.y += popup.rise * dt;
      this.scratch.copy(popup.world);
      if (!this.frustum.containsPoint(this.scratch)) {
        popup.el.style.opacity = '0';
        continue;
      }
      this.scratch.project(camera);
      const x = (this.scratch.x * 0.5 + 0.5) * width;
      const y = (-this.scratch.y * 0.5 + 0.5) * height;
      const t = popup.life / popup.maxLife;
      popup.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(0.85 + t * 0.35).toFixed(3)})`;
      popup.el.style.opacity = String(Math.min(1, t * 1.7));
    }
  }

  dispose(): void {
    bus.offOwner(this);
    for (const popup of this.popups) popup.el.remove();
    this.popups.length = 0;
    for (const piece of this.detachedEnemyParts) piece.group.removeFromParent();
    this.detachedEnemyParts.length = 0;
    this.damageSparkEmitters.length = 0;
    for (const attachment of this.damageAttachments) attachment.mesh.removeFromParent();
    this.damageAttachments.length = 0;
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    this.particleGeo.dispose();
    this.tracerGeo.dispose();
    this.ringGeo.dispose();
    this.flashGeo.dispose();
    this.damageSocketGeo.dispose();
    this.damageRingGeo.dispose();
    this.damagePatchGeo.dispose();
    this.particles.length = 0;
    this.tracers.length = 0;
    this.rings.length = 0;
    this.flashes.length = 0;
    this.group.clear();
  }
}

/** Beam + item for ground loot: the real gun model for weapons, a gem otherwise. */
export interface LootVisual {
  group: THREE.Group;
  /** Node rotated each frame (the gun or the gem). */
  spinner: THREE.Object3D;
  setHighlight(active: boolean): void;
  dispose(): void;
}

const beamGeo = new THREE.CylinderGeometry(0.42, 0.6, 7, 8, 1, true);
const gemGeo = new THREE.OctahedronGeometry(0.34, 0);
const haloGeo = new THREE.RingGeometry(0.55, 0.85, 18);
haloGeo.rotateX(-Math.PI / 2);

export function createLootVisual(rarity: string, weapon?: Weapon | null): LootVisual {
  const color = new THREE.Color(RARITY_HEX[rarity] ?? 0xffffff);
  const group = new THREE.Group();

  const beamMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = 3.5;
  group.add(beam);

  const haloMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.y = 0.05;
  group.add(halo);

  // Weapons show the actual procedural gun, lying flat in the beam.
  if (weapon) {
    const gun = buildGunModel(weapon, { detail: 'low' });
    fitGunLength(gun, 0.52);
    const spinner = new THREE.Group();
    gun.group.rotation.set(-Math.PI / 2.6, 0, 0.35);
    spinner.position.y = 0.62;
    spinner.add(gun.group);
    group.add(spinner);
    return {
      group,
      spinner,
      setHighlight(active: boolean): void {
        beamMat.opacity = active ? 0.62 : 0.3;
        haloMat.opacity = active ? 0.95 : 0.55;
        spinner.scale.setScalar(active ? 1.28 : 1);
        gun.setGlow(active ? 1 : 0.25);
      },
      dispose(): void {
        beamMat.dispose();
        haloMat.dispose();
        gun.dispose();
        group.clear();
      },
    };
  }

  const gemMat = new THREE.MeshLambertMaterial({ color, emissive: color.clone().multiplyScalar(0.7), flatShading: true });
  const gem = new THREE.Mesh(gemGeo, gemMat);
  gem.position.y = 0.75;
  group.add(gem);

  return {
    group,
    spinner: gem,
    setHighlight(active: boolean): void {
      beamMat.opacity = active ? 0.62 : 0.3;
      haloMat.opacity = active ? 0.95 : 0.55;
      gem.scale.setScalar(active ? 1.35 : 1);
    },
    dispose(): void {
      beamMat.dispose();
      gemMat.dispose();
      haloMat.dispose();
      group.clear();
    },
  };
}

export function disposeSharedLootGeometries(): void {
  beamGeo.dispose();
  gemGeo.dispose();
  haloGeo.dispose();
}
