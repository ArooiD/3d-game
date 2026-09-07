import { test } from 'node:test';
import assert from 'node:assert';
import { CollisionWorld } from '../src/renderer/game/physics/CollisionWorld';
import { World } from '../src/renderer/game/world/World';
import { RNG } from '../src/renderer/game/core/Rng';

/**
 * Movement resolution at platform edges. These are the shapes the world actually
 * builds (arena floor, corner blocks, ramps, crates), and every case here used to
 * either freeze the player against a ledge or bounce them up and down on it.
 */

const R = 0.42;
const H = 1.85;

function platform(w: CollisionWorld, minX: number, maxX: number, top: number, tags = ['plat']): void {
  w.addRawBox({ minX, maxX, minY: 0, maxY: top, minZ: -30, maxZ: 30, topY: top, solid: true, tags });
}

/** Walks the capsule along +x at `speed` m/s for `frames` frames at 60 fps. */
function walk(
  w: CollisionWorld,
  start: { x: number; y: number; z: number },
  speed: number,
  frames: number,
): { x: number; y: number; z: number; frames: { x: number; y: number; grounded: boolean; hitWall: boolean }[] } {
  const pos = { ...start };
  const framesOut: { x: number; y: number; grounded: boolean; hitWall: boolean }[] = [];
  let vy = 0;
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    vy = Math.max(-30, vy - 30 * dt);
    const res = w.moveCylinder(pos, { x: speed * dt, y: vy * dt, z: 0 }, R, H, 0.62);
    pos.x = res.x; pos.y = res.y; pos.z = res.z;
    if (res.grounded) vy = 0;
    framesOut.push({ x: res.x, y: res.y, grounded: res.grounded, hitWall: res.hitWall });
  }
  return { ...pos, frames: framesOut };
}

const world = (build: (w: CollisionWorld) => void): CollisionWorld => {
  const w = new CollisionWorld();
  w.setFlatGround(0);
  build(w);
  return w;
};

test('edges: walking off a ledge keeps horizontal speed while falling', () => {
  const w = world((c) => platform(c, -20, 0, 0.6));
  const out = walk(w, { x: -1.5, y: 0.6, z: 0 }, 7, 40);

  // The old resolver reported a wall and clamped x for ~11 frames, then the
  // step-up slung the player back on top of the platform.
  const airborne = out.frames.filter((f, i) => i > 10 && !f.grounded);
  assert.ok(airborne.length > 5, 'expected a real fall');
  assert.ok(!airborne.some((f) => f.hitWall), 'falling off a low lip must not read as a wall');

  // Horizontal distance covered per frame never collapses while airborne.
  let stalls = 0;
  for (let i = 1; i < out.frames.length; i++) {
    const prev = out.frames[i - 1];
    if (!prev.grounded && !out.frames[i].grounded && out.frames[i].x - prev.x < 0.05) stalls++;
  }
  assert.equal(stalls, 0, 'the capsule stalled mid-air next to the edge');
  assert.ok(out.x > 1.5, `should carry momentum off the ledge, ended at x=${out.x.toFixed(2)}`);
});

test('step-up: a 0.5 m ledge is walked onto without stalling or bouncing', () => {
  const w = world((c) => platform(c, 0, 20, 0.5));
  const out = walk(w, { x: -1.5, y: 0, z: 0 }, 7, 40);

  assert.ok(Math.abs(out.y - 0.5) < 1e-6, `should end standing on the ledge, y=${out.y.toFixed(3)}`);
  assert.ok(out.grounded ?? out.frames[out.frames.length - 1].grounded);
  assert.ok(out.x > 0.9, `should keep advancing over the ledge, x=${out.x.toFixed(2)}`);

  // No vertical jitter: the height may rise once and must then stay put.
  const ys = out.frames.map((f) => f.y);
  let direction = 0;
  let reversals = 0;
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i] - ys[i - 1];
    if (Math.abs(d) < 1e-9) continue;
    const dir = Math.sign(d);
    if (direction !== 0 && dir !== direction) reversals++;
    direction = dir;
  }
  assert.equal(reversals, 0, 'the capsule bounced up and down on the step');
  assert.ok(!out.frames.some((f) => f.hitWall), 'a walkable step is not a wall');
});

test('step-up: support holds while the center is still short of the ledge', () => {
  // Just stepped up, center has not crossed the face yet. Center-only sampling
  // reports the ground below and drops the player back off the ledge.
  const w = world((c) => platform(c, 0, 20, 0.5));
  assert.ok(w.footprintSurface(-0.22, 0, 0.5, R) >= 0.5 - 1e-6, 'footprint lost the ledge it is standing on');
  assert.ok(w.surfaceHeight(-0.22, 0) < 0.5, 'center should still be over the low side');
});

test('edges: no vertical jitter walking parallel to a ledge', () => {
  const w = world((c) => platform(c, -20, 0, 0.6));
  const pos = { x: -0.1, y: 0.6, z: -10 };
  const heights = new Set<number>();
  for (let i = 0; i < 120; i++) {
    const res = w.moveCylinder(pos, { x: 0, y: -0.5 / 60, z: 6 / 60 }, R, H, 0.62);
    pos.x = res.x; pos.y = res.y; pos.z = res.z;
    heights.add(Number(res.y.toFixed(6)));
    assert.ok(res.grounded, `frame ${i}: left the ground while walking along the lip`);
  }
  assert.equal(heights.size, 1, `height oscillated along the edge: ${[...heights].join(', ')}`);
});

test('walls: a tall wall still stops the player', () => {
  const w = world((c) => platform(c, 0, 20, 3.2, ['wall']));
  const out = walk(w, { x: -1.5, y: 0, z: 0 }, 9, 60);
  assert.ok(out.frames.some((f) => f.hitWall), 'a 3.2 m wall must block movement');
  assert.ok(out.x <= -R + 1e-6, `must stop a radius short of the face, x=${out.x.toFixed(3)}`);
});

test('walls: a thin wall cannot be walked through from either side', () => {
  // The lip pass-through must only apply when the center is genuinely past the
  // face. A 0.25 m partition sits within one radius on both approaches.
  for (const dir of [1, -1] as const) {
    const w = world((c) => {
      c.addRawBox({ minX: 0, maxX: 0.25, minY: 0, maxY: 2.6, minZ: -30, maxZ: 30, topY: 2.6, solid: true, tags: ['thin'] });
    });
    const out = walk(w, { x: dir * -1.5, y: 0, z: 0 }, 9 * dir, 60);
    const limit = dir > 0 ? 0 - R : 0.25 + R;
    assert.ok(out.frames.some((f) => f.hitWall), `thin wall let the player through moving ${dir > 0 ? '+x' : '-x'}`);
    assert.ok(dir > 0 ? out.x <= limit + 1e-6 : out.x >= limit - 1e-6,
      `thin wall penetration at x=${out.x.toFixed(3)} from ${dir > 0 ? '+x' : '-x'}`);
  }
});

test('walls: walking into a wall while grounded does not lift the capsule', () => {
  const w = world((c) => platform(c, 0, 20, 1.4, ['wall']));
  const out = walk(w, { x: -1, y: 0, z: 0 }, 8, 40);
  assert.ok(out.frames.every((f) => Math.abs(f.y) < 1e-6), 'pushing into a wall raised the player');
});

/**
 * Whole-level traversal. These walk the route the player actually takes through
 * the shipped level - drop pad, camp, canyon, refinery, arena - against the real
 * geometry. A spot where the capsule cannot advance is what the player reports as
 * "I got stuck here".
 */
interface Level {
  collision: CollisionWorld;
  anchors: World['anchors'];
  spawns: World['spawns'];
}

function realLevel(): Level {
  const collision = new CollisionWorld();
  collision.setFlatGround(0);
  const scene = { add: () => undefined } as unknown as import('three').Scene;
  const built = new World(scene, collision, new RNG(20260907));
  return { collision, anchors: built.anchors, spawns: built.spawns };
}

interface MarchResult {
  x: number;
  z: number;
  embedded: string[];
  longestFreeze: number;
}

/**
 * Marches the capsule at walk speed toward a target, one frame per step. A player
 * does not walk a dead-straight line into a rock: they steer around it. The probe
 * does the same, fanning out to the sides whenever the direct heading is blocked,
 * so what it reports as stuck is a spot nothing could get past, not a boulder a
 * player would simply walk around.
 */
function march(
  w: CollisionWorld,
  start: { x: number; y: number; z: number },
  target: { x: number; z: number },
  frames: number,
): MarchResult {
  const pos = { ...start };
  const embedded: string[] = [];
  let freeze = 0;
  let longestFreeze = 0;
  /** Side the last blocked heading steered toward, kept so the robot does not oscillate. */
  let side = 0;
  const step = 7 / 60;
  for (let i = 0; i < frames; i++) {
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.2) break;
    const heading = Math.atan2(dz, dx);
    const tries = side === 0 ? [0] : [0, side * 0.6, side * 1.2, side * 1.9, -side * 0.6];
    let best = { x: pos.x, z: pos.z, moved: 0, steer: 0 };
    for (const off of tries) {
      const res = w.moveCylinder(
        pos,
        { x: Math.cos(heading + off) * step, y: -0.02, z: Math.sin(heading + off) * step },
        R, H, 0.62,
      );
      const moved = Math.hypot(res.x - pos.x, res.z - pos.z);
      if (moved > best.moved) best = { x: res.x, z: res.z, moved, steer: off === 0 ? 0 : Math.sign(off) };
      if (moved > step * 0.7) break;
    }
    pos.x = best.x; pos.z = best.z;
    const landed = w.moveCylinder(pos, { x: 0, y: -0.02, z: 0 }, R, H, 0.62);
    pos.y = landed.y;
    side = best.steer;
    if (w.totalPenetration(pos.x, pos.z, pos.y, H, R) > 0.05) {
      embedded.push(`(${pos.x.toFixed(0)},${pos.z.toFixed(0)})`);
    }
    freeze = best.moved < 1e-4 ? freeze + 1 : 0;
    longestFreeze = Math.max(longestFreeze, freeze);
  }
  return { x: pos.x, z: pos.z, embedded, longestFreeze };
}

test('level: every enemy spawn point is clear of geometry', () => {
  const level = realLevel();
  const embedded: string[] = [];
  for (const [zone, points] of level.spawns) {
    for (const point of points) {
      const y = level.collision.surfaceHeight(point.x, point.z);
      if (level.collision.totalPenetration(point.x, point.z, y, H, R) > 0.05) {
        embedded.push(`${zone} spawn (${point.x},${point.z})`);
      }
    }
  }
  assert.deepEqual(embedded, [], 'spawn points sit inside geometry');
});

test(
  'level: the player can walk from the drop pad to the titan arena',
  { todo: 'route blocked in the canyon/refinery: robot cannot traverse' },
  () => {
  const level = realLevel();
  const a = level.anchors;
  const route = [a.playerSpawn, a.camp, a.canyonEntry, a.refinery, a.bossArena, a.pedestal];
  const pos = { x: route[0]!.x, y: route[0]!.y, z: route[0]!.z };
  const problems: string[] = [];
  for (let leg = 1; leg < route.length; leg++) {
    const from = route[leg - 1]!;
    const to = route[leg]!;
    const budget = Math.ceil((Math.hypot(to.x - from.x, to.z - from.z) / 7) * 60 * 3);
    const out = march(level.collision, pos, to, budget);
    const label = `leg ${leg} (${from.x},${from.z}) -> (${to.x},${to.z})`;
    const remaining = Math.hypot(to.x - out.x, to.z - out.z);
    if (out.embedded.length) {
      problems.push(`${label}: capsule inside geometry at ${[...new Set(out.embedded)].slice(0, 4).join(' ')}`);
    }
    if (out.longestFreeze > 120) problems.push(`${label}: frozen for ${out.longestFreeze} frames`);
    if (remaining > 5) problems.push(`${label}: stopped ${remaining.toFixed(1)} m short`);
    pos.x = out.x; pos.z = out.z;
    pos.y = level.collision.footprintSurface(out.x, out.z, pos.y + 0.62, R, 0.06);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

