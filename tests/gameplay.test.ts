import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CollisionWorld } from '../src/renderer/game/physics/CollisionWorld';
import { findPath } from '../src/renderer/game/physics/Navigation';
import { FixedStep } from '../src/renderer/game/core/FixedStep';
import { CombatSystem } from '../src/renderer/game/combat/CombatSystem';
import { TargetGrid, rayCylinder } from '../src/renderer/game/enemies/TargetRegistry';
import { Enemy } from '../src/renderer/game/enemies/Enemy';
import { EnemyFactory } from '../src/renderer/game/enemies/EnemyModels';
import { enemyDefinition } from '../src/renderer/data/enemies/enemies';
import type { EffectsSystem } from '../src/renderer/game/effects/EffectsSystem';
const effects = { impactHit() {}, fleshHit() {}, explosion() {}, ring() {} } as unknown as EffectsSystem;
const v = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const close = (a: number,b: number) => assert.ok(Math.abs(a-b)<1e-6, `${a} != ${b}`);

test('nearby props do not become phantom floors; roofs do not lift characters', () => {
 const w = new CollisionWorld(); w.addBox(v(5,2,5),v(2,4,2));
 close(w.surfaceHeight(1,1),0);
 w.addBox(v(0,4,0),v(4,1,4)); close(w.standingY(0,0,0,.4,1.8),0);
 close(w.moveCylinder(v(),v(.2,0,0),.4,1.8,.6).y,0);
});
test('fast motion stops at thin walls and slides tangentially', () => {
 const w = new CollisionWorld(); w.addBox(v(3,2,0),v(.1,4,20));
 const p = w.moveCylinder(v(),v(20,0,3),.4,1.8,.6);
 close(p.x,2.55); close(p.z,3); assert.ok(p.hitWall);
});
test('steps require support and clear headroom; descending lands on top', () => {
 const w = new CollisionWorld(); w.addBox(v(2,.25,0),v(2,.5,3));
 close(w.moveCylinder(v(),v(2,0,0),.4,1.8,.6).y,.5);
 close(w.moveCylinder(v(2,5,0),v(0,-10,0),.4,1.8,.6).y,.5);
 w.addBox(v(2,2.1,0),v(2,.2,3));
 assert.ok(w.moveCylinder(v(),v(2,0,0),.4,1.8,.6).x < 1);
});
test('ceiling sweep stops upward motion without teleporting onto roof', () => {
 const w = new CollisionWorld(); w.addBox(v(0,3,0),v(4,.2,4));
 const p = w.moveCylinder(v(),v(0,10,0),.4,1.8,.6);
 close(p.y,1.1); assert.ok(p.hitCeiling);
});
test('rays choose nearest ground and handle origin inside geometry', () => {
 const w = new CollisionWorld(); w.addBox(v(0,-4,0),v(2,1,2));
 close(w.raycast(v(0,3,0),v(0,-1,0),20)!.distance,3);
 w.addBox(v(5,2,0),v(2,4,2)); close(w.raycast(v(5,2,0),v(1,0,0),20)!.distance,0);
});
test('vertical and inside-body shots intersect correctly', () => {
 close(rayCylinder(v(0,4,0),v(0,-1,0),v(),.4,0,2,10)!.distance,2);
 close(rayCylinder(v(0,1,0),v(1,0,0),v(),.4,0,2,10)!.distance,0);
});
test('simulation gives equal tick counts at 30, 60 and 144 FPS; stalls are bounded', () => {
 for (const fps of [30,60,144]) {
  const clock = new FixedStep(); let ticks=0;
  for(let i=0;i<fps*3;i++) clock.advance(1/fps,()=>ticks++);
  assert.equal(ticks,180);
  assert.equal(clock.advance(10,()=>{}),8);
  clock.reset(); assert.equal(clock.advance(1/144,()=>{}),0);
 }
});
test('navigation routes around a wall using traversable edges', () => {
 const w = new CollisionWorld(); w.addBox(v(3,2,0),v(1,4,5));
 const path=findPath(w,v(),v(7,0,0),.4,1.8); assert.ok(path.length>0);
 assert.ok(path.some(p=>Math.abs(p.z)>2.5));
 assert.ok(path.at(-1)!.x>5);
});
test('projectile speed is exact, zero gravity stays level, walls protect player', () => {
 const w=new CollisionWorld(), scene=new THREE.Scene();
 const c=new CombatSystem(scene,w,effects,new TargetGrid()); let damage=0;
 c.fireProjectile({origin:v(0,1,0),direction:v(1,0,0),speed:60,damage:10,fromPlayer:false,gravity:0});
 c.update(1/60,()=>damage++); close(scene.children[0]!.position.x,1); close(scene.children[0]!.position.y,1);
 w.addBox(v(2,1,0),v(.1,2,4));
 c.update(.1,()=>damage++,{position:v(4,0,0),radius:.4,height:1.8,alive:true});
 assert.equal(damage,0); assert.equal(c.activeProjectiles,0); c.dispose();
});
test('hostile projectile hits player once along its swept trajectory', () => {
 const c=new CombatSystem(new THREE.Scene(),new CollisionWorld(),effects,new TargetGrid()); let damage=0;
 c.fireProjectile({origin:v(0,1,0),direction:v(1,0,0),speed:130,damage:10,fromPlayer:false});
 c.update(.1,amount=>damage+=amount,{position:v(4,0,0),radius:.4,height:1.8,alive:true});
 c.update(.1,amount=>damage+=amount); assert.equal(damage,10); c.dispose();
});
test('enemy loses unseen target, does not shoot through cover, and falls while idle', () => {
 const def=enemyDefinition('raider')!, factory=new EnemyFactory(), built=factory.create(def);
 const enemy=new Enemy(def,1,built.rig,built.dispose); enemy.place(0,5,0);
 const context={dt:1/60,playerPosition:v(8,0,0),playerAlive:true,playerVisible:true,damagePlayer(){},shootAt(){shots++;},explodeAt(){},time:0};
 const w=new CollisionWorld(); let shots=0;
 for(let i=0;i<90;i++) enemy.tick(context,w,effects);
 assert.ok(['attack','chase'].includes(enemy.state));
 context.playerVisible=false; const before=shots;
 for(let i=0;i<400;i++) enemy.tick(context,w,effects);
 assert.equal(shots,before); assert.ok(['idle','patrol'].includes(enemy.state)); close(enemy.position.y,0);
 enemy.detach();
});

test('target bounds crossing a grid boundary are found once; dead targets disappear', () => {
 const def=enemyDefinition('raider')!, built=new EnemyFactory().create(def);
 const enemy=new Enemy(def,1,built.rig,built.dispose); enemy.place(12.1,0,0);
 const grid=new TargetGrid(); grid.register(enemy);
 assert.equal(grid.querySphere(v(11.9,1,0),.2).length,1);
 assert.equal(grid.querySphere(v(12,1,0),3).length,1);
 enemy.alive=false; assert.equal(grid.querySphere(v(12,1,0),3).length,0);
 enemy.detach();
});
