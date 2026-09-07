import * as THREE from 'three';
import { GRAVITY, JUMP_VELOCITY, PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS } from '../../../shared/constants';
import { bus } from '../core/EventBus';
import { input } from '../core/Input';
import { damp } from '../core/Rng';
import type { CollisionWorld } from '../physics/CollisionWorld';
import type { PlayerState } from './PlayerState';

/**
 * First-person character controller. Ground-relative movement with acceleration
 * and deceleration, reduced air control, jump, sprint and step-up collision —
 * deliberately not a free floating camera.
 */

const GROUND_ACCEL = 68;
const GROUND_DECEL = 78;
const AIR_ACCEL = 18;
const AIR_DECEL = 8;
const MAX_AIR_CONTROL = 3.2;
const EYE_BOB_AMOUNT = 0.045;
const LAND_SQUASH_TIME = 0.14;

export class PlayerController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Feet position; the camera sits PLAYER_EYE_HEIGHT above it. */
  yaw = 0;
  pitch = 0;
  grounded = false;
  sprinting = false;
  crouching = false;
  /** True while the player is inside the safe drop-pad zone. */
  inSafeZone = false;

  private fallStartY = 0;
  private jumpBuffer = 0;
  private coyoteTime = 0;
  private bobPhase = 0;
  private bobIntensity = 0;
  private landSquash = 0;
  private cameraRoll = 0;
  /** Set by abilities and recoil, applied to the camera each frame. */
  readonly shake = new THREE.Vector3();
  private shakeAmount = 0;

  /** Velocity magnitude the camera uses for footstep timing. */
  stepDistance = 0;

  constructor(
    private collision: CollisionWorld,
    private player: PlayerState,
    private camera: THREE.PerspectiveCamera,
  ) {}

  teleport(x: number, y: number, z: number, yaw = 0): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.fallStartY = y;
    this.jumpBuffer = 0;
    this.coyoteTime = 0;
    this.crouching = false;
    this.updateCamera(0);
  }

  /** Impulse used by explosions and knockback. */
  addImpulse(x: number, y: number, z: number): void {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
  }

  addShake(amount: number): void {
    this.shakeAmount = Math.min(1.6, this.shakeAmount + amount);
  }

  look(dx: number, dy: number, sensitivity: number, invertY: boolean): void {
    if (!input.pointerLocked) return;
    this.yaw -= dx * sensitivity;
    this.pitch -= (invertY ? -dy : dy) * sensitivity;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  consumeLook(): { dx: number; dy: number } {
    const dx = input.lookDeltaX;
    const dy = input.lookDeltaY;
    input.lookDeltaX = 0;
    input.lookDeltaY = 0;
    return { dx, dy };
  }

  forwardVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  rightVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  aimDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeHeight() - this.bobOffset(), this.position.z);
  }

  private eyeHeight(): number {
    return this.crouching ? PLAYER_HEIGHT * 0.62 - 0.15 : PLAYER_EYE_HEIGHT;
  }

  private bobOffset(): number {
    return Math.abs(Math.sin(this.bobPhase)) * EYE_BOB_AMOUNT * this.bobIntensity + this.landSquash * 0.16;
  }

  private wishDirection(out: THREE.Vector3): THREE.Vector3 {
    const forward = input.forward;
    const strafe = input.strafe;
    if (forward === 0 && strafe === 0) {
      return out.set(0, 0, 0);
    }
    const f = this.forwardVector(TEMP_A);
    const r = this.rightVector(TEMP_B);
    out.set(f.x * forward + r.x * strafe, 0, f.z * forward + r.z * strafe);
    if (out.lengthSq() > 1) out.normalize();
    return out;
  }

  update(dt: number): void {
    const stats = this.player.stats;
    const buffSpeed = this.player.buff.moveSpeed;

    this.sprinting = input.sprinting && input.forward > 0 && !input.aiming;
    this.crouching = input.crouching || (this.crouching && this.collision.overlaps(
      this.position.x, this.position.y, this.position.z, PLAYER_RADIUS, PLAYER_HEIGHT,
    ).length > 0);

    const targetSpeed = this.crouching
      ? stats.movementSpeed * 0.5
      : this.sprinting
        ? stats.sprintSpeed
        : stats.movementSpeed;

    const wish = this.wishDirection(TEMP_WISH);

    // Accelerate / decelerate toward the wish direction.
    const current = TEMP_VEL.set(this.velocity.x, 0, this.velocity.z);
    const currentSpeed = current.length();
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;
    const decel = this.grounded ? GROUND_DECEL : AIR_DECEL;

    if (wish.lengthSq() > 0.0001) {
      wish.multiplyScalar(targetSpeed * buffSpeed);
      if (!this.grounded) {
        // Cap how much a player can steer mid-air.
        const addSpeed = wish.length() - current.dot(wish.clone().normalize());
        if (addSpeed > MAX_AIR_CONTROL) {
          wish.normalize().multiplyScalar(current.dot(wish.clone().normalize()) + MAX_AIR_CONTROL);
        }
      }
      const target = wish;
      this.velocity.x = approach(this.velocity.x, target.x, (currentSpeed > targetSpeed && this.grounded ? decel : accel) * dt);
      this.velocity.z = approach(this.velocity.z, target.z, (currentSpeed > targetSpeed && this.grounded ? decel : accel) * dt);
    } else {
      const stop = decel * dt;
      this.velocity.x = approach(this.velocity.x, 0, stop);
      this.velocity.z = approach(this.velocity.z, 0, stop);
    }

    this.jumpBuffer = input.wasPressed('Space') ? 0.12 : Math.max(0, this.jumpBuffer - dt);
    this.coyoteTime = this.grounded ? 0.1 : Math.max(0, this.coyoteTime - dt);
    // Buffered jump and a brief grace period after leaving a ledge.
    if (this.jumpBuffer > 0 && this.coyoteTime > 0) {
      this.jumpBuffer = 0;
      this.coyoteTime = 0;
      this.velocity.y = JUMP_VELOCITY * (this.crouching ? 0.8 : 1);
      this.grounded = false;
      this.fallStartY = this.position.y;
      bus.emit('player:jump', {});
    }

    // Gravity.
    this.velocity.y -= GRAVITY * dt;
    if (this.velocity.y < -60) this.velocity.y = -60;

    const delta = TEMP_DELTA.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const result = this.collision.moveCylinder(
      this.position,
      delta,
      PLAYER_RADIUS,
      this.crouching ? PLAYER_HEIGHT * 0.62 : PLAYER_HEIGHT,
      0.62,
    );

    const landed = !this.grounded && result.grounded;
    if (result.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;
    if (result.hitWall) {
      // Project the horizontal velocity onto the face that stopped the body.
      // Zeroing whole world axes kept the tangential speed only for axis-aligned
      // walls and dead-stopped the player at an outer corner or against any prop
      // that was not square to the map.
      const into = this.velocity.x * result.normalX + this.velocity.z * result.normalZ;
      if (into < 0) {
        this.velocity.x -= result.normalX * into;
        this.velocity.z -= result.normalZ * into;
      }
    }
    this.position.set(result.x, result.y, result.z);
    this.grounded = result.grounded;

    if (this.grounded) {
      if (landed) {
        const fallDistance = Math.max(0, this.fallStartY - this.position.y);
        const impact = Math.min(1, fallDistance / 12);
        this.velocity.y = 0;
        if (impact > 0.12) {
          this.landSquash = impact;
          this.addShake(impact * 0.5);
          bus.emit('player:land', { impact });
        }
      } else {
        this.velocity.y = 0;
        this.fallStartY = this.position.y;
      }
    } else {
      this.fallStartY = Math.max(this.fallStartY, this.position.y);
    }

    // Head bob driven by real ground speed.
    const groundSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const bobTarget = this.grounded ? Math.min(1, groundSpeed / Math.max(1, stats.sprintSpeed)) : 0;
    this.bobIntensity = damp(this.bobIntensity, bobTarget, 0.08, dt);
    this.bobPhase += dt * (6.4 + groundSpeed * 0.62);
    this.stepDistance += groundSpeed * dt;

    this.landSquash = damp(this.landSquash, 0, LAND_SQUASH_TIME, dt);

    // Slight lean into strafe for game feel.
    const leanTarget = -input.strafe * 0.014 * (this.sprinting ? 1.5 : 1);
    this.cameraRoll = damp(this.cameraRoll, leanTarget, 0.1, dt);
  }

  updateCamera(dt: number): void {
    const shakeDecay = Math.exp(-dt * 12);
    this.shakeAmount *= shakeDecay;
    if (this.shakeAmount < 0.001) this.shakeAmount = 0;
    const s = this.shakeAmount;
    this.shake.set(
      (Math.random() - 0.5) * s * 0.36,
      (Math.random() - 0.5) * s * 0.36,
      (Math.random() - 0.5) * s * 0.2,
    );

    const eyeY = this.eyeHeight() - this.bobOffset();
    this.camera.position.set(
      this.position.x + this.shake.x,
      this.position.y + eyeY + this.shake.y,
      this.position.z + this.shake.z,
    );
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, this.cameraRoll);
  }

  /** Zone checks and other read-only queries used by the director. */
  distanceTo(x: number, z: number): number {
    const dx = this.position.x - x;
    const dz = this.position.z - z;
    return Math.hypot(dx, dz);
  }
}

const TEMP_A = new THREE.Vector3();
const TEMP_B = new THREE.Vector3();
const TEMP_WISH = new THREE.Vector3();
const TEMP_VEL = new THREE.Vector3();
const TEMP_DELTA = new THREE.Vector3();

function approach(current: number, target: number, delta: number): number {
  if (current < target) return Math.min(current + delta, target);
  if (current > target) return Math.max(current - delta, target);
  return current;
}
