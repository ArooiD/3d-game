# Post-patch cleanups for the drone and the enemy manager.

p = 'src/renderer/game/player/CombatDrone.ts'
s = open(p).read()
s = s.replace("import { rng } from '../core/Rng';\n", "")
if 'droneDamage' in s and 'rng.' in s.split('droneDamage')[1]:
    s = s.replace("  return rng.float(base * 0.85, base * 1.15);", "  return base * (0.85 + Math.random() * 0.3);")
open(p, 'w').write(s)

# EnemyManager: expose a live loot-drop helper used by the drop table.
p = 'src/renderer/game/enemies/EnemyManager.ts'
s = open(p).read()
if 'export interface EnemyEvents' in s and 'pickupPoint' not in s:
    s = s.replace(
        "  explode: (point: THREE.Vector3, radius: number, damage: number) => void;",
        "  explode: (point: THREE.Vector3, radius: number, damage: number) => void;\n  /** Ground level at a spot, used to seat loot on the floor. */\n  groundY: (x: number, z: number) => number;",
    )
open(p, 'w').write(s)

print('patch5 applied')
