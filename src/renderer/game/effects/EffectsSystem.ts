import * as THREE from 'three';
import { RARITY_HEX } from '../../../shared/constants';
import { bus, GameEvents } from '../core/EventBus';
import { rng } from '../core/Rng';

/**
 * Pooled visual effects: impact sparks, muzzle flashes, tracers, explosion
 * rings, floating damage numbers and loot beams. Everything is allocated up
 * front and recycled, so combat produces no GC pressure.
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
  private particleGeo: THREE.BufferGeometry;
  private tracerGeo: THREE.BufferGeometry;
  private ringGeo: THREE.BufferGeometry;
  private flashGeo: THREE.BufferGeometry;
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

    this.buildPools();
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
    void bus;
    void GameEvents;
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

    this.updatePopups(dt);
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
    for (const popup of this.popups) popup.el.remove();
    this.popups.length = 0;
    for (const mat of this.materials) mat.dispose();
    this.materials.length = 0;
    this.particleGeo.dispose();
    this.tracerGeo.dispose();
    this.ringGeo.dispose();
    this.flashGeo.dispose();
    this.particles.length = 0;
    this.tracers.length = 0;
    this.rings.length = 0;
    this.flashes.length = 0;
    this.group.clear();
  }
}

/** Beam + rotating gem for ground loot, one small group per item. */
export interface LootVisual {
  group: THREE.Group;
  setHighlight(active: boolean): void;
  dispose(): void;
}

const beamGeo = new THREE.CylinderGeometry(0.42, 0.6, 7, 8, 1, true);
const gemGeo = new THREE.OctahedronGeometry(0.34, 0);
const haloGeo = new THREE.RingGeometry(0.55, 0.85, 18);
haloGeo.rotateX(-Math.PI / 2);

export function createLootVisual(rarity: string): LootVisual {
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

  const gemMat = new THREE.MeshLambertMaterial({ color, emissive: color.clone().multiplyScalar(0.7), flatShading: true });
  const gem = new THREE.Mesh(gemGeo, gemMat);
  gem.position.y = 0.75;
  group.add(gem);

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

  return {
    group,
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
