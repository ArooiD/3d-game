import type { CollisionWorld } from './CollisionWorld';
type Point = { x: number; y: number; z: number };
/** Bounded local A*: each edge uses the same collision rules as characters. */
export function findPath(world: CollisionWorld, start: Point, goal: Point, radius: number, height: number): Point[] {
  const spacing = Math.max(1.5, radius * 2.2);
  type Node = Point & { ix: number; iz: number; g: number; f: number; parent?: Node };
  const first: Node = { ...start, ix: 0, iz: 0, g: 0, f: 0 };
  const open = [first];
  const costs = new Map<string, number>([['0,0', 0]]);
  let best = first, bestDistance = Math.hypot(goal.x - start.x, goal.z - start.z);
  for (let count = 0; open.length && count < 220; count++) {
    open.sort((a, b) => b.f - a.f);
    const node = open.pop()!;
    if (node.g > (costs.get(`${node.ix},${node.iz}`) ?? Infinity)) continue;
    const distance = Math.hypot(goal.x - node.x, goal.z - node.z);
    if (distance < bestDistance) { bestDistance = distance; best = node; }
    if (distance < spacing) { best = node; break; }
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
      const ix = node.ix + dx!, iz = node.iz + dz!;
      const x = start.x + ix * spacing, z = start.z + iz * spacing;
      const move = world.moveCylinder(node, { x: x - node.x, y: -0.1, z: z - node.z }, radius, height, 0.7);
      if (Math.hypot(move.x - x, move.z - z) > 0.05 || Math.abs(move.y - node.y) > 0.7) continue;
      const g = node.g + Math.hypot(dx!, dz!) * spacing;
      const key = `${ix},${iz}`;
      if (g >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, g);
      open.push({ x, y: move.y, z, ix, iz, g, f: g + Math.hypot(goal.x - x, goal.z - z), parent: node });
    }
  }
  const path: Point[] = [];
  for (let node: Node | undefined = best; node?.parent; node = node.parent) path.push({ x: node.x, y: node.y, z: node.z });
  return path.reverse();
}
