import * as THREE from 'three';
import type { EnemyDefinition } from '../../../shared/types';
import { audio, SoundName } from '../audio/AudioSystem';
import { bus, GameEvents } from '../core/EventBus';
import { rng } from '../core/Rng';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { EffectsSystem } from '../effects/EffectsSystem';
import { rayCylinder, type DamageOptions, type TargetRegistry } from './TargetRegistry';

/**
 * Enemy entity: finite state machine + simple steering. States are exactly the
 * ones the design calls for (Idle, Patrol, Alert, Chase, Attack, Retreat, Dead)
 * and behaviour differs per archetype through `behavior` parameters in data.
 */

export type EnemyState = 'idle' | 'patrol' | 'alert' | 'chase' | 'attack' | 'retreat' | 'dead';

export interface EnemyTickContext {
  dt: number;
  playerPosition: THREE.Vector3;
  playerAlive: boolean;
  /** Distance the enemy currently has to the player. */
  playerVisible: boolean;
  damagePlayer: (amount: number, from: THREE.Vector3) => void;
  /** Boss/missiles route through the projectile system. */
  shootAt: (origin: THREE.Vector3, dir: THREE.Vector3, damage: number, speed: number) => void;
  explodeAt: (point: THREE.Vector3, radius: number, damage: number) => void;
  time: number;
}

const STATE_COLORS: Record<EnemyState, number> = {
  idle: 0x000000,
  patrol: 0x000000,
  alert: 0xffd166,
  chase: 0xff8b3d,
  attack: 0xff4d4d,
  retreat: 0x7fd0ff,
  dead: 0x000000,
};

let nextEnemyId = 0;

export class Enemy implements TargetRegistry {
  readonly id: string;
  readonly definition: EnemyDefinition;
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  /** Feet position, synced to the group each frame. */
  state: EnemyState = 'idle';
  health: number;
  maxHealth: number;
  shield: number;
  maxShield: number;
  damage: number;
  moveSpeed: number;
  alive = true;
  /** Seconds the corpse stays before despawn. */
  private corpseTimer = 0;
  private stateTimer = 0;
  private attackTimer = 0;
  private patrolTarget = new THREE.Vector3();
  private home = new THREE.Vector3();
  private yaw = 0;
  private hitFlash = 0;
  private bobPhase = rng.angle();
  private strafeDir = rng.bool() ? 1 : -1;
  private strafeTimer = rng.float(1.4, 3.2);
  private lastKnownPlayer = new THREE.Vector3();
  private shieldRegenTimer = 0;
  private deathNotified = false;
  /** Boss phase 2 latch. */
  bossPhase = 1;
  private burstRemaining = 0;
  private burstTimer = 0;
  private areaTimer = 5;
  private summonTimer = 3;
  private avoidTimer = 0;
  private avoidDir = new THREE.Vector3();
  private lastDamageFrom: 'player' | 'other' = 'other';

  private rig: {
    root: THREE.Group;
    torso: THREE.Mesh;
    head: THREE.Mesh;
    legL: THREE.Mesh;
    legR: THREE.Mesh;
    armL: THREE.Mesh;
    armR: THREE.Mesh;
    visor: THREE.Mesh;
    barrel: THREE.Mesh | null;
    shieldRing: THREE.Mesh | null;
  };

  private disposables: () => void;

  constructor(
    definition: EnemyDefinition,
    levelScale: number,
    rig: {
      root: THREE.Group;
      torso: THREE.Mesh;
      head: THREE.Mesh;
      legL: THREE.Mesh;
      legR: THREE.Mesh;
      armL: THREE.Mesh;
      armR: THREE.Mesh;
      visor: THREE.Mesh;
      barrel: THREE.Mesh | null;
      shieldRing: THREE.Mesh | null;
    },
    disposables: () => void,
  ) {
    this.id = `enemy_${nextEnemyId++}`;
    this.definition = definition;
    this.rig = rig;
    this.disposables = disposables;
    this.group.add(rig.root);
    this.group.name = `enemy-${definition.id}`;

    this.maxHealth = Math.round(definition.health * levelScale);
    this.maxShield = Math.round(definition.shield * levelScale);
    this.health = this.maxHealth;
    this.shield = this.maxShield;
    this.damage = definition.damage * (0.75 + levelScale * 0.3);
    this.moveSpeed = definition.moveSpeed;
    this.home.set(0, 0, 0);
  }

  // ------------------------------------------------------------ Target API

  get root(): THREE.Object3D {
    return this.group;
  }

  get hostile(): boolean {
    return this.alive;
  }

  get isBoss(): boolean {
    return this.definition.behavior === 'boss';
  }

  get radius(): number {
    return this.definition.radius;
  }

  get height(): number {
    return this.definition.height;
  }

  get centre(): THREE.Vector3 {
    return TEMP_CENTRE.set(this.position.x, this.position.y + this.definition.height * 0.55, this.position.z);
  }

  get headY(): number {
    return this.position.y + this.definition.height;
  }

  get eyeY(): number {
    return this.position.y + this.definition.height * (this.isBoss ? 0.86 : 0.94);
  }

  get chestPosition(): THREE.Vector3 {
    return TEMP_CENTRE.set(this.position.x, this.position.y + this.definition.height * 0.6, this.position.z);
  }

  distanceTo(point: THREE.Vector3): number {
    const dx = this.position.x - point.x;
    const dy = this.position.y + this.definition.height * 0.5 - point.y;
    const dz = this.position.z - point.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  rayHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number) {
    if (!this.alive) return null;
    return rayCylinder(
      origin,
      dir,
      { x: this.position.x, y: 0, z: this.position.z } as unknown as THREE.Vector3,
      this.definition.radius,
      this.position.y,
      this.headY,
      maxDistance,
    );
  }

  place(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.home.set(x, y, z);
    this.group.position.set(x, y, z);
    this.patrolTarget.set(x, y, z);
  }

  // ---------------------------------------------------------------- damage

  applyDamage(amount: number, options: DamageOptions): void {
    if (!this.alive || amount <= 0) return;
    if (options.fromPlayer) {
      this.lastDamageFrom = 'player';
      if (this.state === 'idle' || this.state === 'patrol') this.becomeAlerted();
    }

    let remaining = amount;
    const shieldBonus = 1 + options.shieldBonus;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining * shieldBonus);
      this.shield -= absorbed;
      remaining -= absorbed / shieldBonus;
      this.shieldRegenTimer = 6;
    }
    if (remaining > 0) this.health -= remaining;

    this.hitFlash = 0.12;
    this.attackTimer = Math.max(0, this.attackTimer - 0.25);

    bus.emit(GameEvents.EnemyDamaged, {
      id: this.id,
      definitionId: this.definition.id,
      health: this.health,
      shield: this.shield,
      critical: options.critical,
      headshot: options.headshot,
      point: this.chestPosition.clone(),
      damage: amount,
      isBoss: this.isBoss,
    });

    if (options.direction.lengthSq() > 0.01 && !this.isBoss) {
      // Small knockback for readability on light hits.
      const kb = Math.min(0.6, amount / 120);
      this.position.addScaledVector(options.direction, kb * 0.3);
    }

    if (this.definition.behavior === 'boss' && this.bossPhase === 1 && this.health <= this.maxHealth * 0.5) {
      this.bossPhase = 2;
      this.moveSpeed = this.definition.moveSpeed * 1.45;
      this.summonTimer = 0.6;
      bus.emit(GameEvents.BossPhase, { phase: 2, name: this.definition.name });
      audio.play(SoundName.BossPhase);
    }

    if (this.health <= 0) this.die(options.fromPlayer);
  }

  /** `byPlayer` gates XP credit so environmental deaths do not reward. */
  die(byPlayer = true): void {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    this.corpseTimer = this.isBoss ? 4 : 2.4;
    this.health = 0;
    this.shield = 0;
    this.setVisualState();
    this.group.rotation.x = 0;

    if (!this.deathNotified) {
      this.deathNotified = true;
      audio.play(this.isBoss ? SoundName.BossDeath : SoundName.EnemyDeath, this.isBoss ? 1 : 0.75);
      bus.emit(GameEvents.EnemyKilled, {
        id: this.id,
        definitionId: this.definition.id,
        position: this.position.clone(),
        byPlayer,
        isBoss: this.isBoss,
        isElite: Boolean(this.definition.isElite),
        xpReward: this.definition.xpReward,
        lootChance: this.definition.lootChance,
        name: this.definition.name,
      });
    }
    void byPlayer;
  }

  /** Called by the spawner when the corpse animation finishes. */
  get despawnReady(): boolean {
    return !this.alive && this.corpseTimer <= 0;
  }

  private becomeAlerted(): void {
    if (this.state === 'alert' || this.state === 'chase' || this.state === 'attack') return;
    this.setState('alert', 0.45);
  }

  forceAggro(): void {
    this.becomeAlerted();
  }

  private setState(next: EnemyState, duration?: number): void {
    if (this.state === next) return;
    this.state = next;
    this.stateTimer = duration ?? 0;
    this.setVisualState();
  }

  private setVisualState(): void {
    const tint = STATE_COLORS[this.state];
    const visor = this.rig.visor.material as THREE.MeshLambertMaterial;
    if (visor && visor.emissive) {
      visor.emissive.setHex(this.state === 'dead' ? 0x000000 : tint === 0x000000 ? this.definition.accentHex : tint);
    }
  }

  // -------------------------------------------------------------- behaviour

  tick(context: EnemyTickContext, collision: CollisionWorld, effects: EffectsSystem): void {
    const { dt } = context;

    if (!this.alive) {
      this.corpseTimer -= dt;
      // Topple over and sink slightly.
      const t = Math.max(0, Math.min(1, 1 - this.corpseTimer / 2.4));
      this.group.rotation.x = -Math.PI * 0.42 * t;
      this.group.position.y = this.position.y - t * 0.25;
      return;
    }

    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const flash = Math.max(0, this.hitFlash / 0.12);
      const torso = this.rig.torso.material as THREE.MeshLambertMaterial;
      if (torso && torso.emissive) torso.emissive.setRGB(flash, flash * 0.5, flash * 0.2);
    }

    if (this.shieldRegenTimer > 0) {
      this.shieldRegenTimer -= dt;
    } else if (this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + this.maxShield * 0.08 * dt);
    }

    const dx = context.playerPosition.x - this.position.x;
    const dz = context.playerPosition.z - this.position.z;
    const flatDistance = Math.hypot(dx, dz);
    const detection = this.definition.detectionRadius * (this.lastDamageFrom === 'player' ? 1.6 : 1);

    // --- transitions -----------------------------------------------------
    if (this.state !== 'dead') {
      if (!context.playerAlive) {
        this.setState('idle');
      } else if (flatDistance <= detection && (context.playerVisible || this.state === 'chase' || this.lastDamageFrom === 'player')) {
        this.lastKnownPlayer.copy(context.playerPosition);
        if (this.state === 'idle' || this.state === 'patrol' || this.state === 'alert') {
          this.becomeAlerted();
          audio.playAt(SoundName.EnemyAlert, flatDistance, 45, 400);
          if (this.state === 'alert') {
            this.stateTimer -= dt;
            if (this.stateTimer <= 0) this.setState('chase');
          }
        }
      } else if (this.state === 'chase' || this.state === 'attack' || this.state === 'retreat') {
        // Lost the player: search briefly, then calm down.
        this.stateTimer += dt;
        if (this.stateTimer > 6) {
          this.lastDamageFrom = 'other';
          this.setState('patrol');
          this.pickPatrolTarget();
        }
      }

      if (this.state === 'idle' || this.state === 'patrol') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.pickPatrolTarget();
          this.setState('patrol', rng.float(3, 7));
        }
      }
    }

    // --- movement + attack by state --------------------------------------
    switch (this.state) {
      case 'idle':
        this.standStill(dt);
        break;
      case 'patrol':
        this.moveTo(this.patrolTarget, this.moveSpeed * 0.5, dt, collision, context);
        this.faceTowards(this.patrolTarget.x, this.patrolTarget.z, dt, 3);
        break;
      case 'alert':
        this.faceTowards(context.playerPosition.x, context.playerPosition.z, dt, 6);
        this.standStill(dt);
        break;
      case 'chase':
        this.chase(context, dt, collision);
        break;
      case 'attack':
        this.attack(context, dt, collision);
        break;
      case 'retreat':
        this.retreat(context, dt, collision);
        break;
      default:
        break;
    }

    // --- boss extras ------------------------------------------------------
    if (this.isBoss && this.alive) {
      this.tickBoss(context, effects);
    }

    // --- apply transform + animation --------------------------------------
    this.group.position.set(this.position.x, this.position.y, this.position.z);
    this.group.rotation.y = this.yaw;
    this.animate(context.dt, flatDistance);
    void effects;
  }

  private pickPatrolTarget(): void {
    const angle = rng.angle();
    const radius = rng.float(3, 12);
    this.patrolTarget.set(this.home.x + Math.cos(angle) * radius, this.home.y, this.home.z + Math.sin(angle) * radius);
    this.setState('idle', rng.float(1.2, 3.4));
  }

  private standStill(dt: number): void {
    this.bobPhase += dt * 2;
  }

  private faceTowards(x: number, z: number, dt: number, rate: number): void {
    const target = Math.atan2(-(x - this.position.x), -(z - this.position.z));
    let delta = target - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += delta * Math.min(1, rate * dt);
  }

  /** Steering with obstacle avoidance: probe ahead, slide along blockers. */
  private moveTo(
    destination: THREE.Vector3,
    speed: number,
    dt: number,
    collision: CollisionWorld,
    context: EnemyTickContext,
  ): void {
    let dirX = destination.x - this.position.x;
    let dirZ = destination.z - this.position.z;
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.05) return;
    dirX /= len;
    dirZ /= len;

    this.avoidTimer -= dt;
    if (this.avoidTimer <= 0) {
      this.avoidTimer = 0.28;
      const probeDistance = this.definition.radius + 2.4;
      const origin = TEMP_ORIGIN.set(this.position.x, this.position.y + this.definition.height * 0.4, this.position.z);
      const dir = TEMP_DIR.set(dirX, 0, dirZ);
      const hit = collision.raycast(origin, dir, probeDistance);
      if (hit) {
        // Slide: use the wall normal to deflect movement.
        const nx = hit.normal.x;
        const nz = hit.normal.z;
        const slideX = -nz;
        const slideZ = nx;
        const dot = slideX * dirX + slideZ * dirZ;
        this.avoidDir.set(slideX * Math.sign(dot || 1), 0, slideZ * Math.sign(dot || 1));
      } else {
        this.avoidDir.set(0, 0, 0);
      }
    }

    let moveX = dirX;
    let moveZ = dirZ;
    if (this.avoidDir.lengthSq() > 0.01) {
      moveX = dirX * 0.35 + this.avoidDir.x * 0.9;
      moveZ = dirZ * 0.35 + this.avoidDir.z * 0.9;
      const m = Math.hypot(moveX, moveZ) || 1;
      moveX /= m;
      moveZ /= m;
    }

    const result = collision.moveCylinder(
      this.position,
      { x: moveX * speed * dt, y: -12 * dt, z: moveZ * speed * dt },
      this.definition.radius,
      this.definition.height,
      0.7,
    );
    this.position.set(result.x, result.y, result.z);
    this.bobPhase += dt * (5 + speed);
    void context;
  }

  /** Keeps the preferred stand-off distance and strafes. */
  private holdDistance(context: EnemyTickContext, dt: number, collision: CollisionWorld): void {
    const preferred = this.definition.preferredRange;
    const dx = context.playerPosition.x - this.position.x;
    const dz = context.playerPosition.z - this.position.z;
    const distance = Math.hypot(dx, dz) || 1;
    const dirX = dx / distance;
    const dirZ = dz / distance;

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rng.float(1.2, 2.8);
      this.strafeDir = rng.bool() ? 1 : -1;
    }

    let moveX = 0;
    let moveZ = 0;
    const band = 3.5;
    if (distance > preferred + band) {
      moveX = dirX;
      moveZ = dirZ;
    } else if (distance < preferred - band) {
      moveX = -dirX;
      moveZ = -dirZ;
    }
    // Always add some lateral motion so enemies are harder to line up.
    moveX += -dirZ * this.strafeDir * 0.75;
    moveZ += dirX * this.strafeDir * 0.75;
    const m = Math.hypot(moveX, moveZ);
    if (m > 0.001) {
      this.moveTo(
        TEMP_DEST.set(this.position.x + (moveX / m) * 5, this.position.y, this.position.z + (moveZ / m) * 5),
        this.moveSpeed,
        dt,
        collision,
        context,
      );
    }
    this.faceTowards(context.playerPosition.x, context.playerPosition.z, dt, 7);
  }

  private chase(context: EnemyTickContext, dt: number, collision: CollisionWorld): void {
    const distance = this.distanceTo(context.playerPosition);
    if (distance <= this.definition.attackRange && context.playerVisible) {
      this.setState('attack');
      this.attackTimer = Math.max(this.attackTimer, 0.25);
      return;
    }
    if (this.isBoss) {
      this.moveTo(context.playerPosition, this.moveSpeed, dt, collision, context);
      this.faceTowards(context.playerPosition.x, context.playerPosition.z, dt, 2.4);
      if (distance <= this.definition.attackRange) this.setState('attack');
      return;
    }
    this.holdDistance(context, dt, collision);
  }

  private attack(context: EnemyTickContext, dt: number, collision: CollisionWorld): void {
    const distance = this.distanceTo(context.playerPosition);
    this.faceTowards(context.playerPosition.x, context.playerPosition.z, dt, 8);

    if (this.stateTimer > 0) this.stateTimer -= dt;
    if (this.stateTimer <= 0 && !context.playerVisible) {
      this.setState('chase');
      return;
    }
    if (distance > this.definition.attackRange * 1.25) {
      this.setState('chase');
      return;
    }

    const melee = this.definition.behavior === 'rusher';
    if (!melee) this.holdDistance(context, dt, collision);

    // Burst pacing for automatic enemies.
    this.burstTimer -= dt;
    if (this.burstRemaining > 0 && this.burstTimer <= 0) {
      this.burstRemaining -= 1;
      this.burstTimer = 0.11;
      this.shoot(context, distance);
    }

    this.attackTimer -= dt;
    if (this.attackTimer > 0) return;

    if (melee) {
      if (distance <= this.definition.attackRange + 0.8) {
        this.attackTimer = this.definition.attackInterval;
        context.damagePlayer(this.damage, this.position);
        this.rig.armR.rotation.x = -1.4;
      } else {
        this.setState('chase');
      }
      return;
    }

    const interval = this.definition.attackInterval;
    this.attackTimer = interval;
    if (this.definition.behavior === 'heavy') {
      this.burstRemaining = 3;
      this.burstTimer = 0;
    } else if (this.definition.behavior === 'raider') {
      this.burstRemaining = rng.bool(0.4) ? 2 : 1;
      this.burstTimer = 0;
    } else {
      // Snipers lead with a pause, then one heavy shot.
      this.burstRemaining = 1;
      this.burstTimer = 0.25;
      this.attackTimer = interval + rng.float(0.2, 0.8);
    }

    // Occasionally reposition after firing so fights do not stall.
    if (rng.bool(0.3) && !melee) {
      this.strafeDir *= -1;
      this.stateTimer = 1.2;
    }
  }

  private shoot(context: EnemyTickContext, distance: number): void {
    const origin = this.muzzlePoint.clone();

    // Aim at the chest with archetype accuracy error that grows with distance.
    const spread =
      this.definition.behavior === 'sniper'
        ? 0.006
        : this.definition.behavior === 'heavy'
          ? 0.035
          : 0.05;
    const targetY = context.playerPosition.y + 1.0;
    const dir = TEMP_DIR.set(
      context.playerPosition.x - origin.x + rng.float(-1, 1) * spread * distance,
      targetY - origin.y + rng.float(-1, 1) * spread * distance * 0.5,
      context.playerPosition.z - origin.z + rng.float(-1, 1) * spread * distance,
    ).normalize();

    const speed = this.definition.behavior === 'sniper' ? 130 : 62;
    context.shootAt(origin.clone(), dir.clone(), this.damage, speed);
    audio.playAt('weapon_shot_rifle', this.distanceTo(context.playerPosition), 70, 30);
  }

  private retreat(context: EnemyTickContext, dt: number, collision: CollisionWorld): void {
    const dirX = this.position.x - context.playerPosition.x;
    const dirZ = this.position.z - context.playerPosition.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    this.moveTo(
      TEMP_DEST.set(this.position.x + (dirX / len) * 8, this.position.y, this.position.z + (dirZ / len) * 8),
      this.moveSpeed,
      dt,
      collision,
      context,
    );
    this.faceTowards(context.playerPosition.x, context.playerPosition.z, dt, 5);
    if (this.distanceTo(context.playerPosition) > this.definition.preferredRange * 1.4) {
      this.setState('attack');
    }
  }

  // --------------------------------------------------------------- boss kit

  private tickBoss(context: EnemyTickContext, effects: EffectsSystem): void {
    const phase2 = this.bossPhase === 2;

    if (phase2) {
      // Reinforcements.
      this.summonTimer -= context.dt;
      if (this.summonTimer <= 0) {
        this.summonTimer = 18;
        bus.emit(GameEvents.BossSummon, {
          position: this.position.clone(),
          definitions: ['raider', 'rusher'],
        });
      }

      // Sweeping area attack.
      this.areaTimer -= context.dt;
      if (this.areaTimer <= 0) {
        this.areaTimer = 9;
        const point = this.position.clone().setY(this.position.y + 0.3);
        effects.ring(point, 13, 0xff6a3d, 0.85);
        audio.playAt(SoundName.Explosion, this.distanceTo(context.playerPosition), 90);
        context.explodeAt(point, 13, this.damage * 1.1);
      }
    }
  }

  /** Called by the boss controller for its missile barrage. */
  get bossUsesMissiles(): boolean {
    return true;
  }

  get muzzlePoint(): THREE.Vector3 {
    return TEMP_MUZZLE
      .set(this.position.x, this.eyeY - 0.1, this.position.z)
      .addScaledVector(TEMP_DIR.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), this.definition.radius + 0.6);
  }

  // ---------------------------------------------------------------- visual

  private animate(dt: number, distanceToPlayer: number): void {
    const moving = this.state === 'chase' || this.state === 'patrol' || this.state === 'retreat' || this.state === 'attack';
    const speedFactor = moving ? 1 : 0;
    this.bobPhase += dt * 2 * speedFactor;
    const swing = Math.sin(this.bobPhase * 2.2) * 0.55 * speedFactor;
    this.rig.legL.rotation.x = swing;
    this.rig.legR.rotation.x = -swing;
    if (this.state !== 'attack' || this.definition.behavior === 'rusher') {
      this.rig.armL.rotation.x = -swing * 0.6;
    }
    this.rig.armR.rotation.x = THREE.MathUtils.lerp(this.rig.armR.rotation.x, this.state === 'attack' ? -1.45 : -swing * 0.6, Math.min(1, dt * 8));

    const idleBreath = Math.sin(this.bobPhase) * 0.02;
    this.rig.torso.position.y = (this.isBoss ? 3.6 : 1.25) + idleBreath;

    if (this.rig.shieldRing) {
      this.rig.shieldRing.rotation.z += dt * 1.1;
      const active = this.shield > 0.5;
      this.rig.shieldRing.visible = active;
      if (active) {
        const mat = this.rig.shieldRing.material as THREE.MeshLambertMaterial;
        mat.opacity = 0.35 + 0.35 * (this.shield / Math.max(1, this.maxShield));
        mat.transparent = true;
      }
    }

    // Elites and the boss get a subtle bob so they read as bigger threats.
    if (this.isBoss) {
      this.group.position.y = this.position.y + Math.sin(this.bobPhase * 0.8) * 0.08;
    }
    void distanceToPlayer;
  }

  detach(): void {
    this.group.parent?.remove(this.group);
    this.disposables();
  }

  get healthRatio(): number {
    return this.health / Math.max(1, this.maxHealth);
  }
}

const TEMP_CENTRE = new THREE.Vector3();
const TEMP_ORIGIN = new THREE.Vector3();
const TEMP_DIR = new THREE.Vector3();
const TEMP_DEST = new THREE.Vector3();
const TEMP_MUZZLE = new THREE.Vector3();