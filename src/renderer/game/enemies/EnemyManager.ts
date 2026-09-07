import * as THREE from 'three';
import type { EnemyBehavior } from '../../../shared/types';
import { ENEMY_LIST, enemyDefinition } from '../../data/enemies/enemies';
import { audio, SoundName } from '../audio/AudioSystem';
import { bus, GameEvents } from '../core/EventBus';
import { rng } from '../core/Rng';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { EffectsSystem } from '../effects/EffectsSystem';
import { Enemy, type EnemyTickContext } from './Enemy';
import { EnemyFactory, HealthBarPool, scaleForLevel } from './EnemyModels';
import { TargetGrid } from './TargetRegistry';

/**
 * Owns every live enemy: spawning, per-archetype loadout, AI ticking, line of
 * sight, health bars and corpse recycling. The GameDirector asks this to place
 * groups; the combat system reads the shared TargetGrid.
 */

export interface SpawnRequest {
  definitionId: string;
  x: number;
  z: number;
  y?: number;
  /** Marks the spawn as part of the boss fight so deaths do not double-reward. */
  bossMinion?: boolean;
}

export interface EnemyEvents {
  damagePlayer: (amount: number, from: THREE.Vector3) => void;
  shoot: (origin: THREE.Vector3, dir: THREE.Vector3, damage: number, speed: number) => void;
  explode: (point: THREE.Vector3, radius: number, damage: number) => void;
  /** Ground level at a spot, used to seat loot on the floor. */
  groundY: (x: number, z: number) => number;
  playerPosition: THREE.Vector3;
  playerAlive: boolean;
}

const ENGAGED = new Set(['alert', 'chase', 'attack', 'retreat']);

/** Seconds a focus label survives leaving the aim cone, to avoid strobing. */
const FOCUS_HOLD = 0.25;
const FOCUS_DIR = new THREE.Vector3();
const FOCUS_TO = new THREE.Vector3();

export class EnemyManager {
  readonly enemies: Enemy[] = [];
  readonly targets = new TargetGrid();
  private factory = new EnemyFactory();
  private healthBars: HealthBarPool;
  private camera: THREE.Camera;
  /** Enemies killed by the player, consumed by the quest system each frame. */
  private killQueue: { definitionId: string; byPlayer: boolean; isBoss: boolean; isElite: boolean; position: THREE.Vector3 }[] = [];
  private losRaycaster = new THREE.Ray();
  private scratch = new THREE.Vector3();
  /** Enemy currently under the crosshair, driving the label on its health bar. */
  private focusTarget: Enemy | null = null;
  private focusHold = 0;

  constructor(
    private scene: THREE.Scene,
    private collision: CollisionWorld,
    private effects: EffectsSystem,
    overlay: HTMLElement,
    camera: THREE.Camera,
  ) {
    this.camera = camera;
    this.healthBars = new HealthBarPool(overlay, 20);
  }

  get aliveCount(): number {
    let count = 0;
    for (const enemy of this.enemies) if (enemy.alive) count++;
    return count;
  }

  countBehavior(behavior: EnemyBehavior, aliveOnly = true): number {
    let count = 0;
    for (const enemy of this.enemies) {
      if (aliveOnly && !enemy.alive) continue;
      if (enemy.definition.behavior === behavior) count++;
    }
    return count;
  }

  countDefinition(definitionId: string, aliveOnly = true): number {
    let count = 0;
    for (const enemy of this.enemies) {
      if (aliveOnly && !enemy.alive) continue;
      if (enemy.definition.id === definitionId) count++;
    }
    return count;
  }

  findById(id: string): Enemy | null {
    for (const enemy of this.enemies) {
      if (enemy.id === id) return enemy;
    }
    return null;
  }

  /** Nearest living enemy to a point, used by the combat drone. */
  nearestAlive(point: THREE.Vector3, maxDistance = 40): Enemy | null {
    let best: Enemy | null = null;
    let bestDistance = maxDistance;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const distance = enemy.distanceTo(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = enemy;
      }
    }
    return best;
  }

  get boss(): Enemy | null {
    for (const enemy of this.enemies) {
      if (enemy.isBoss && enemy.alive) return enemy;
    }
    return null;
  }

  spawn(request: SpawnRequest, playerLevel: number): Enemy | null {
    const definition = enemyDefinition(request.definitionId);
    if (!definition) return null;

    const scale = scaleForLevel(playerLevel);
    const built = this.factory.create(definition);
    const enemy = new Enemy(definition, scale, built);
    enemy.level = Math.max(1, Math.round(playerLevel));
    const y = request.y ?? this.groundY(request.x, request.z);
    enemy.place(request.x, y, request.z);
    enemy.bossMinion = Boolean(request.bossMinion);

    // Per-archetype loadout flourishes.
    if (definition.isElite) {
      enemy.maxHealth = Math.round(enemy.maxHealth * 1.15);
      enemy.health = enemy.maxHealth;
      enemy.damage *= 1.15;
    }
    if (definition.behavior === 'sniper') {
      built.barrel?.scale.set(1, 1, 1.5);
    }

    this.scene.add(enemy.group);
    this.enemies.push(enemy);
    this.targets.register(enemy);
    bus.emit(GameEvents.EnemySpawned, {
      id: enemy.id,
      definitionId: definition.id,
      position: enemy.position.clone(),
      bossMinion: Boolean(request.bossMinion),
    });
    return enemy;
  }

  spawnGroup(requests: SpawnRequest[], playerLevel: number): Enemy[] {
    const out: Enemy[] = [];
    for (const request of requests) {
      const enemy = this.spawn(request, playerLevel);
      if (enemy) out.push(enemy);
    }
    return out;
  }

  /** Aggro everything within `radius` of a point (used by alarm triggers). */
  alertNear(point: THREE.Vector3, radius: number): number {
    let count = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      if (enemy.distanceTo(point) <= radius) {
        enemy.forceAggro();
        count++;
      }
    }
    return count;
  }

  /** Removes every enemy, used on state teardown / respawn. */
  clear(): void {
    for (const enemy of this.enemies) {
      this.targets.unregister(enemy);
      enemy.detach();
    }
    this.enemies.length = 0;
    this.killQueue.length = 0;
    this.focusTarget = null;
    this.focusHold = 0;
    this.targets.clear();
  }

  /** Drains queued kills; the quest system and director consume these. */
  drainKills(): typeof this.killQueue {
    const out = this.killQueue;
    this.killQueue = [];
    return out;
  }

  private groundY(x: number, z: number): number {
    const hit = this.collision.raycast(
      { x, y: 40, z },
      this.scratch.set(0, -1, 0),
      80,
    );
    return hit ? hit.point.y + 0.02 : 0.2;
  }

  /** Line of sight test against world geometry only. */
  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dir = this.scratch.copy(to).sub(from);
    const distance = dir.length();
    if (distance < 0.01) return true;
    dir.multiplyScalar(1 / distance);
    const hit = this.collision.raycast({ x: from.x, y: from.y, z: from.z }, dir, distance - 0.4);
    return hit === null;
  }

  update(dt: number, events: EnemyEvents, time: number): void {
    const eye = events.playerPosition;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy) continue;

      if (enemy.despawnReady) {
        this.targets.unregister(enemy);
        enemy.detach();
        this.enemies.splice(i, 1);
        continue;
      }

      const eyePoint = this.scratch.set(enemy.position.x, enemy.eyeY, enemy.position.z).clone();
      const playerEye = new THREE.Vector3(eye.x, eye.y + 1.2, eye.z);
      const visible = enemy.alive
        ? enemy.distanceTo(playerEye) < enemy.definition.detectionRadius * 1.6 &&
          this.hasLineOfSight(eyePoint, playerEye)
        : false;

      const context: EnemyTickContext = {
        dt,
        playerPosition: eye,
        playerAlive: events.playerAlive,
        playerVisible: visible,
        damagePlayer: events.damagePlayer,
        shootAt: events.shoot,
        explodeAt: events.explode,
        time,
      };

      enemy.tick(context, this.collision, this.effects);
    }

    // Kills are reported through the bus; collect them for external systems.
    this.targets.rebuild();
    this.updateHealthBars(dt);
    void this.losRaycaster;
    void time;
  }

  private updateHealthBars(dt: number): void {
    const focused = this.updateFocus(dt);
    const entries: { object: THREE.Object3D; offsetY: number; label?: string; focused?: boolean }[] = [];
    const sorted = this.enemies
      // Show the bar once a foe is engaged, not only after the first hit: a bar
      // that pops in mid-fight is easier to read than one that is missing while
      // you are deciding which target to shoot. A foe under the crosshair always
      // gets one - the player is asking "what am I looking at?".
      .filter((enemy) => enemy.alive
        && (enemy === focused || enemy.health < enemy.maxHealth || enemy.shield < enemy.maxShield
          || ENGAGED.has(enemy.state) || enemy.isBoss))
      .sort((a, b) => a.distanceTo(this.cameraPos()) - b.distanceTo(this.cameraPos()));
    for (const enemy of sorted.slice(0, 20)) {
      const isFocus = enemy === focused;
      entries.push({
        object: enemy.group,
        offsetY: enemy.definition.height + 0.95,
        focused: isFocus,
        // Name + level belong to the focused bar only; permanent labels over every
        // raider would clutter the screen.
        label: isFocus ? `${enemy.definition.name} · LV ${enemy.level}` : undefined,
      });
    }
    this.healthBars.assign(entries);
    this.healthBars.update(this.camera, (object) => {
      const enemy = this.enemies.find((candidate) => candidate.group === object);
      if (!enemy || !enemy.alive) return null;
      const far = enemy.distanceTo(this.cameraPos()) > 70;
      return {
        hp: enemy.health,
        maxHp: enemy.maxHealth,
        shield: enemy.shield,
        maxShield: enemy.maxShield,
        hidden: far,
      };
    });
  }

  /**
   * The enemy the player is currently aiming at: the alive target whose body
   * covers the crosshair ray with the smallest angular offset and which is not
   * hidden behind cover. Held briefly after leaving the cone so the label does not
   * strobe while tracking a moving target.
   */
  private updateFocus(dt: number): Enemy | null {
    this.camera.getWorldDirection(FOCUS_DIR);
    const origin = this.camera.position;
    let best: Enemy | null = null;
    let bestAngle = Number.POSITIVE_INFINITY;
    let bestDist = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      FOCUS_TO.set(enemy.position.x - origin.x, enemy.headY - 0.25 - origin.y, enemy.position.z - origin.z);
      const dist = FOCUS_TO.length();
      if (dist < 0.001) continue;
      FOCUS_TO.divideScalar(dist);
      const cos = THREE.MathUtils.clamp(FOCUS_TO.dot(FOCUS_DIR), -1, 1);
      const angle = Math.acos(cos);
      // Angular radius of the target, plus a small grace window so crosshair
      // placement near an edge still counts as aiming at it.
      const limit = Math.atan2(enemy.radius + 0.35, dist);
      if (angle <= limit && angle < bestAngle) {
        best = enemy;
        bestAngle = angle;
        bestDist = dist;
      }
    }
    // The candidate must be shootable: cover between eye and target wins.
    if (best) {
      const hit = this.collision.raycast(origin, FOCUS_DIR, bestDist - 0.4);
      if (hit) best = null;
    }
    if (best) {
      this.focusTarget = best;
      this.focusHold = FOCUS_HOLD;
    } else if (this.focusTarget && this.focusHold > 0) {
      this.focusHold -= dt;
      if (!this.focusTarget.alive || this.focusHold <= 0) this.focusTarget = null;
    } else {
      this.focusTarget = null;
    }
    return this.focusTarget;
  }

  private cameraPos(): THREE.Vector3 {
    return this.camera.position;
  }

  private distanceFromCamera(point: THREE.Vector3): number {
    return point.distanceTo(this.camera.position);
  }

  /** Hook the manager into the event bus for kill bookkeeping. */
  attach(): void {
    bus.on(GameEvents.EnemyKilled, (payload: { definitionId: string; byPlayer: boolean; isBoss: boolean; isElite: boolean; position: THREE.Vector3 }) => {
      this.killQueue.push({
        definitionId: payload.definitionId,
        byPlayer: payload.byPlayer,
        isBoss: payload.isBoss,
        isElite: payload.isElite,
        position: payload.position,
      });
      if (payload.position) {
        audio.playAt(SoundName.LootDrop, this.distanceFromCamera(payload.position), 70);
      }
    });
  }

  /** Debug helper: cycle through the roster. */
  spawnRandomAt(point: THREE.Vector3, playerLevel: number): Enemy | null {
    const pool = ENEMY_LIST.filter((def) => def.behavior !== 'boss');
    const definition = rng.pick(pool);
    return this.spawn({ definitionId: definition.id, x: point.x, z: point.z }, playerLevel);
  }

  dispose(): void {
    this.clear();
    this.healthBars.dispose();
    this.factory.dispose?.();
  }
}
