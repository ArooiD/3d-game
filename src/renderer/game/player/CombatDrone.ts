import * as THREE from 'three';
import { bus, GameEvents } from '../core/EventBus';

/**
 * Engineer's Combat Drone: a small orbiting helper that auto-fires at the
 * nearest hostile. Deliberately simple — it reuses the TargetGrid rather than
 * owning any AI of its own.
 */

export interface DroneContext {
  playerPosition: THREE.Vector3;
  /** Returns true when the shot connected with something. */
  shoot: (origin: THREE.Vector3, dir: THREE.Vector3, damage: number) => boolean;
  onTargetLost: () => void;
}

export class CombatDrone {
  readonly group = new THREE.Group();
  active = false
  private remaining = 0;
  private fireTimer = 0;
  private orbitAngle = 0;
  private readonly body: THREE.Mesh;
  private readonly rotor: THREE.Mesh;
  private readonly geometry = new THREE.BoxGeometry(0.5, 0.22, 0.5);
  private readonly rotorGeometry = new THREE.BoxGeometry(0.72, 0.04, 0.1);
  private readonly bodyMaterial = new THREE.MeshLambertMaterial({ color: 0x39c2d7, emissive: 0x0d5a68 });
  private readonly rotorMaterial = new THREE.MeshLambertMaterial({ color: 0x1c2229 });
  private muzzle = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.body = new THREE.Mesh(this.geometry, this.bodyMaterial);
    this.rotor = new THREE.Mesh(this.rotorGeometry, this.rotorMaterial);
    this.rotor.position.y = 0.2;
    this.group.add(this.body, this.rotor);
    this.group.visible = false;
    scene.add(this.group);
  }

  deploy(duration: number, damage: number): void {
    this.active = true;
    this.remaining = duration;
    this.damage = damage;
    this.fireTimer = 0.35;
    this.group.visible = true;
  }

  private damage = 18;

  recall(): void {
    if (!this.active) return;
    this.active = false;
    this.group.visible = false;
    bus.emit(GameEvents.ActiveSkillUsed, { id: 'drone_recalled', name: 'Drone' });
  }

  update(dt: number, context: DroneContext): void {
    if (!this.active) return;
    this.remaining -= dt;
    if (this.remaining <= 0) {
      this.recall();
      return;
    }

    this.orbitAngle += dt * 1.5;
    const radius = 1.9;
    const target = new THREE.Vector3(
      context.playerPosition.x + Math.cos(this.orbitAngle) * radius,
      context.playerPosition.y + 2.1 + Math.sin(this.orbitAngle * 2.2) * 0.25,
      context.playerPosition.z + Math.sin(this.orbitAngle) * radius,
    );
    this.group.position.lerp(target, Math.min(1, dt * 6));
    this.rotor.rotation.y += dt * 26;

    this.fireTimer -= dt;
    if (this.fireTimer > 0) return;
    this.fireTimer = 0.42;

    const hostile = this.findTarget(context.playerPosition);
    if (!hostile) return;
    const dir = this.muzzle.copy(hostile).sub(this.group.position).normalize();
    const hit = context.shoot(this.group.position.clone().addScaledVector(dir, 0.5), dir, this.damage);
    if (!hit) context.onTargetLost();
  }

  /** Nearest hostile is resolved by the owner and handed in through setTarget. */
  private targetPoint: THREE.Vector3 | null = null;

  setTarget(point: THREE.Vector3 | null): void {
    this.targetPoint = point;
  }

  private findTarget(_origin: THREE.Vector3): THREE.Vector3 | null {
    return this.targetPoint;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.rotorGeometry.dispose();
    this.bodyMaterial.dispose();
    this.rotorMaterial.dispose();
  }
}

/** Small helper so the ability code can jitter the drone damage per shot. */
export function droneDamage(base: number): number {
  return base * (0.85 + Math.random() * 0.3);
}
