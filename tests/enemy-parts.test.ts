import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { EnemyParts } from '../src/renderer/game/enemies/EnemyParts';
import { EnemyFactory } from '../src/renderer/game/enemies/EnemyModels';
import { Enemy } from '../src/renderer/game/enemies/Enemy';
import { TargetGrid } from '../src/renderer/game/enemies/TargetRegistry';
import { CombatSystem } from '../src/renderer/game/combat/CombatSystem';
import { CollisionWorld } from '../src/renderer/game/physics/CollisionWorld';
import { enemyDefinition } from '../src/renderer/data/enemies/enemies';
import type { EffectsSystem } from '../src/renderer/game/effects/EffectsSystem';

const effects = {
  impactHit() {},
  fleshHit() {},
  explosion() {},
  ring() {},
} as unknown as EffectsSystem;

function makeRaider() {
  const definition = enemyDefinition('raider')!;
  const factory = new EnemyFactory();
  const built = factory.create(definition);
  const enemy = new Enemy(definition, 1, built);
  enemy.place(0, 0, 0);
  enemy.group.updateMatrixWorld(true);
  return { definition, factory, built, enemy };
}

test('EnemyParts resolves animated head and arm hit zones', () => {
  const { definition, factory, built, enemy } = makeRaider();
  const parts = new EnemyParts(enemy);

  const head = built.skeleton.bones.get('head')!;
  const headPoint = new THREE.Vector3(0, definition.height * 0.055, -definition.height * 0.004)
    .applyMatrix4(head.matrixWorld);
  const headOrigin = headPoint.clone().add(new THREE.Vector3(0, 0, -4));
  const headDir = headPoint.clone().sub(headOrigin).normalize();
  const headHit = parts.rayHit(headOrigin, headDir, 8);
  assert.equal(headHit?.part, 'head');
  assert.equal(headHit?.headshot, true);

  const arm = built.skeleton.bones.get('armR')!;
  const forearm = built.skeleton.bones.get('forearmR')!;
  const upper = Math.max(definition.height * 0.12, Math.abs(forearm.position.y));
  const armPoint = new THREE.Vector3(0, -upper * 0.35, 0).applyMatrix4(arm.matrixWorld);
  const armOrigin = armPoint.clone().add(new THREE.Vector3(0, 0, -4));
  const armDir = armPoint.clone().sub(armOrigin).normalize();
  const armHit = parts.rayHit(armOrigin, armDir, 8);
  assert.equal(armHit?.part, 'armR');
  assert.equal(armHit?.headshot, false);

  enemy.detach();
  factory.dispose();
});

test('breaking a leg has its own integrity pool, hides the limb and slows the enemy once', () => {
  const { factory, built, enemy } = makeRaider();
  const parts = new EnemyParts(enemy);
  const beforeSpeed = enemy.moveSpeed;
  const state = parts.snapshot('legL');

  const result = parts.applyDamage('legL', state.maxIntegrity + 1);
  assert.equal(result.destroyed, true);
  assert.equal(parts.snapshot('legL').destroyed, true);
  assert.ok(enemy.moveSpeed < beforeSpeed, `speed did not drop: ${enemy.moveSpeed} >= ${beforeSpeed}`);

  const slowedSpeed = enemy.moveSpeed;
  const repeated = parts.applyDamage('legL', 999);
  assert.equal(repeated.destroyed, false, 'part break event must only fire once');
  assert.equal(enemy.moveSpeed, slowedSpeed, 'repeated hits re-applied the movement penalty');

  const legMeshes: THREE.Mesh[] = [];
  built.skeleton.bones.get('thighL')!.traverse((node) => {
    if (node instanceof THREE.Mesh) legMeshes.push(node);
  });
  assert.ok(legMeshes.length > 0, 'left leg has no registered visual meshes');
  assert.ok(legMeshes.some((mesh) => !mesh.visible), 'broken detachable leg stayed fully visible');

  enemy.detach();
  factory.dispose();
});

test('anatomical multipliers make head precision stronger than torso and limbs', () => {
  const { factory, enemy } = makeRaider();
  const parts = new EnemyParts(enemy);
  const torso = parts.applyDamage('torso', 10);
  const head = parts.applyDamage('head', 10);
  const arm = parts.applyDamage('armL', 10);

  assert.equal(torso.bodyDamage, 10);
  assert.ok(head.bodyDamage > torso.bodyDamage);
  assert.ok(arm.bodyDamage < torso.bodyDamage);

  enemy.detach();
  factory.dispose();
});

test('CombatSystem trace reports the concrete EnemyParts slot', () => {
  const { definition, factory, built, enemy } = makeRaider();
  const grid = new TargetGrid();
  grid.register(enemy);
  const combat = new CombatSystem(new THREE.Scene(), new CollisionWorld(), effects, grid);

  enemy.group.updateMatrixWorld(true);
  const head = built.skeleton.bones.get('head')!;
  const point = new THREE.Vector3(0, definition.height * 0.055, -definition.height * 0.004)
    .applyMatrix4(head.matrixWorld);
  const origin = point.clone().add(new THREE.Vector3(0, 0, -5));
  const direction = point.clone().sub(origin).normalize();
  const hit = combat.trace(origin, direction, 10);

  assert.equal(hit.target, enemy);
  assert.equal(hit.part, 'head');
  assert.equal(hit.headshot, true);

  combat.dispose();
  enemy.detach();
  factory.dispose();
});
