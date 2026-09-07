import * as THREE from 'three';
import type { Weapon } from '../../../shared/types';
import { rng } from '../core/Rng';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { EffectsSystem } from '../effects/EffectsSystem';
import type { TargetGrid, TargetRegistry } from '../enemies/TargetRegistry';

/**
 * Hitscan + projectile combat shared by the player and the enemies. Enemy bodies
 * are registered with a TargetRegistry so shot resolution never iterates the
 * scene graph.
 */

export interface HitResult {
  target: TargetRegistry | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  headshot: boolean;
  worldHit: boolean;
}

export interface ShotContext {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  weapon: Weapon;
  /** Player-side stat multipliers folded in by the weapon controller. */
  damage: number;
  criticalChance: number;
  criticalMultiplier: number;
  spread: number;
  shieldBonus: number;
  source: 'player' | 'enemy';
}

export class CombatSystem {
  private projectileGeo: THREE.SphereGeometry;
  private projectileMatFriendly: THREE.MeshBasicMaterial;
  private projectileMatHostile: THREE.MeshBasicMaterial;

  private projectiles: Projectile[] = [];
  private scratch = new THREE.Vector3();
  private scratchDir = new THREE.Vector3();

  stats = { shotsFired: 0, shotsHit: 0 };

  constructor(
    private scene: THREE.Scene,
    private collision: CollisionWorld,
    private effects: EffectsSystem,
    private targets: TargetGrid,
  ) {
    this.projectileGeo = new THREE.SphereGeometry(0.16, 8, 6);
    this.projectileMatFriendly = new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false });
    this.projectileMatHostile = new THREE.MeshBasicMaterial({ color: 0xff6a3d, fog: false });
  }

  /** Resolve one hitscan shot, including spread, falloff, crits and headshots. */
  fireHitscan(context: ShotContext): HitResult[] {
    const results: HitResult[] = [];
    const pellets = Math.max(1, context.weapon.pellets ?? 1);
    this.stats.shotsFired += 1;
    let anyHit = false;

    for (let pellet = 0; pellet < pellets; pellet++) {
      const dir = this.scratchDir.copy(context.direction);
      if (context.spread > 0.0001) {
        applySpread(dir, context.spread);
      }

      const hit = this.trace(context.origin, dir, context.weapon.range);
      const point = hit.point;
      const damageMul = falloffMultiplier(hit.distance, context.weapon.range, context.weapon.falloff);

      if (hit.target) {
        anyHit = true;
        const critical = rng.bool(context.criticalChance);
        const critMul = critical ? context.criticalMultiplier : 1;
        const finalDamage = context.damage * damageMul * critMul;
        hit.target.applyDamage(finalDamage, {
          headshot: hit.headshot,
          critical,
          shieldBonus: context.weapon.shieldDamageBonus + context.shieldBonus,
          direction: dir,
          fromPlayer: context.source === 'player',
        });
        this.effects.fleshHit(point, critical);
        results.push({
          target: hit.target,
          point,
          normal: hit.normal,
          distance: hit.distance,
          headshot: hit.headshot,
          worldHit: false,
        });
      } else if (hit.worldHit) {
        this.effects.impactHit(point, hit.normal);
        results.push({
          target: null,
          point,
          normal: hit.normal,
          distance: hit.distance,
          headshot: false,
          worldHit: true,
        });
      }
    }

    if (anyHit) this.stats.shotsHit += 1;
    return results;
  }

  /** Trace a ray against enemy capsules first, then world geometry. */
  trace(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDistance: number,
    ignore?: TargetRegistry,
  ): { target: TargetRegistry | null; point: THREE.Vector3; normal: THREE.Vector3; distance: number; headshot: boolean; worldHit: boolean } {
    const worldHit = this.collision.raycast(origin, dir, maxDistance);
    let bestDistance = worldHit ? worldHit.distance : maxDistance;
    let bestTarget: TargetRegistry | null = null;
    let headshot = false;

    const candidates = this.targets.queryRay(origin, dir, bestDistance);
    for (const candidate of candidates) {
      if (candidate === ignore) continue;
      const hit = candidate.rayHit(origin, dir, bestDistance);
      if (hit && hit.distance < bestDistance) {
        bestDistance = hit.distance;
        bestTarget = candidate;
        headshot = hit.headshot;
      }
    }

    const point = this.scratch.copy(origin).addScaledVector(dir, bestDistance).clone();
    let normal: THREE.Vector3;
    if (bestTarget) {
      normal = dir.clone().multiplyScalar(-1);
    } else if (worldHit) {
      normal = worldHit.normal.clone();
    } else {
      normal = dir.clone().multiplyScalar(-1);
    }

    return {
      target: bestTarget,
      point,
      normal,
      distance: bestDistance,
      headshot,
      worldHit: !bestTarget && Boolean(worldHit),
    };
  }

  /** Straight travelling projectile with a light arc, used by enemies and the drone. */
  fireProjectile(options: {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    speed: number;
    damage: number;
    shieldBonus?: number;
    fromPlayer: boolean;
    gravity?: number;
    radius?: number;
    life?: number;
    tracerColor?: number;
    critical?: boolean;
  }): void {
    const mesh = new THREE.Mesh(this.projectileGeo, options.fromPlayer ? this.projectileMatFriendly : this.projectileMatHostile);
    mesh.position.copy(options.origin);
    mesh.scale.setScalar(options.radius ? options.radius / 0.16 : 1);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh,
      velocity: options.direction.clone().multiplyScalar(options.speed),
      life: options.life ?? 4,
      damage: options.damage,
      shieldBonus: options.shieldBonus ?? 0,
      fromPlayer: options.fromPlayer,
      radius: options.radius ?? 0.3,
      critical: options.critical ?? false,
    });
  }

  /** Grenade-style lobbed explosive used by the player's Q ability. */
  fireExplosive(options: {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    speed: number;
    fuse: number;
    damage: number;
    radius: number;
    shieldBonus: number;
  }): void {
    const mesh = new THREE.Mesh(this.projectileGeo, this.projectileMatFriendly);
    mesh.scale.setScalar(1.6);
    mesh.position.copy(options.origin);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh,
      velocity: options.direction.clone().multiplyScalar(options.speed).add(new THREE.Vector3(0, 4.5, 0)),
      life: options.fuse,
      damage: options.damage,
      shieldBonus: options.shieldBonus,
      fromPlayer: true,
      radius: 0.4,
      critical: false,
      explosive: { radius: options.radius, damage: options.damage, shieldBonus: options.shieldBonus },
    });
  }

  update(dt: number, onPlayerDamage: (amount: number, point: THREE.Vector3) => void): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      if (!projectile) continue;
      projectile.life -= dt;
      projectile.velocity.y -= 14 * dt;

      const step = this.scratch.copy(projectile.velocity).multiplyScalar(dt);
      const next = projectile.mesh.position.clone().add(step);

      // Advance in small slices so fast rounds cannot tunnel through enemies.
      const slices = Math.max(1, Math.ceil(step.length() / 0.6));
      let consumed = false;
      for (let s = 0; s < slices && !consumed; s++) {
        const t = (s + 1) / slices;
        const probe = projectile.mesh.position.clone().addScaledVector(step, t);

        const target = this.targets.sphereHit(probe, projectile.radius, projectile.fromPlayer);
        if (target) {
          target.applyDamage(projectile.damage, {
            headshot: false,
            critical: projectile.critical,
            shieldBonus: projectile.shieldBonus,
            direction: projectile.velocity.clone().normalize(),
            fromPlayer: projectile.fromPlayer,
          });
          this.effects.fleshHit(probe, projectile.critical);
          consumed = true;
          break;
        }

        const dir = this.scratchDir.copy(projectile.velocity).normalize();
        const wall = this.collision.raycast(projectile.mesh.position, dir, step.length() / slices + 0.05);
        if (wall) {
          this.effects.impactHit(wall.point, wall.normal);
          if (!projectile.fromPlayer) onPlayerDamage(projectile.damage, wall.point);
          consumed = true;
          break;
        }
        projectile.mesh.position.copy(probe);
      }

      const expired = projectile.life <= 0;
      if (consumed || expired || next.y < -6) {
        const center = projectile.mesh.position.clone();
        if (projectile.explosive) {
          this.explode(center, projectile.explosive.radius, projectile.explosive.damage, projectile.explosive.shieldBonus, true);
        }
        this.scene.remove(projectile.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  explode(center: THREE.Vector3, radius: number, damage: number, shieldBonus: number, fromPlayer: boolean): void {
    this.effects.explosion(center, radius);
    const hits = this.targets.querySphere(center, radius);
    for (const target of hits) {
      const distance = target.distanceTo(center);
      const falloff = 1 - Math.min(1, distance / Math.max(0.01, radius)) * 0.55;
      target.applyDamage(damage * falloff, {
        headshot: false,
        critical: false,
        shieldBonus,
        direction: target.position.clone().sub(center).normalize(),
        fromPlayer,
        explosion: true,
      });
    }
  }

  get activeProjectiles(): number {
    return this.projectiles.length;
  }

  clearProjectiles(): void {
    for (const projectile of this.projectiles) this.scene.remove(projectile.mesh);
    this.projectiles.length = 0;
  }

  dispose(): void {
    this.clearProjectiles();
    this.projectileGeo.dispose();
    this.projectileMatFriendly.dispose();
    this.projectileMatHostile.dispose();
  }
}

/** Random cone deviation; `spread` is the half-angle in radians. */
function applySpread(dir: THREE.Vector3, spread: number): void {
  // Gaussian-ish so most shots stay near the reticle.
  const r1 = (Math.random() + Math.random() - 1) * spread;
  const r2 = (Math.random() + Math.random() - 1) * spread;
  const up = Math.abs(dir.y) > 0.95 ? TEMP_RIGHT : TEMP_UP;
  TEMP_SIDE.crossVectors(dir, up).normalize();
  TEMP_UP2.crossVectors(TEMP_SIDE, dir).normalize();
  dir.addScaledVector(TEMP_SIDE, r1).addScaledVector(TEMP_UP2, r2).normalize();
}

const TEMP_UP = new THREE.Vector3(0, 1, 0);
const TEMP_RIGHT = new THREE.Vector3(1, 0, 0);
const TEMP_SIDE = new THREE.Vector3();
const TEMP_UP2 = new THREE.Vector3();

function falloffMultiplier(distance: number, range: number, falloff: number): number {
  if (falloff <= 0) return 1;
  const start = range * 0.6;
  if (distance <= start) return 1;
  const t = Math.min(1, (distance - start) / Math.max(1, range - start));
  return Math.max(1 - falloff, 1 - falloff * t);
}

interface Projectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  damage: number;
  shieldBonus: number;
  fromPlayer: boolean;
  radius: number;
  critical: boolean;
  explosive?: { radius: number; damage: number; shieldBonus: number };
}
