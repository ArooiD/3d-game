# Adds lookup helpers used by the GameDirector and the combat drone.

p = 'src/renderer/game/enemies/EnemyManager.ts'
s = open(p).read()
if 'findById' not in s:
    s = s.replace(
        "  get boss(): Enemy | null {",
        """  findById(id: string): Enemy | null {
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

  get boss(): Enemy | null {""",
    )
open(p, 'w').write(s)

# The GameDirector lives in game/core; it imports systems, so give it the
# relative paths it needs (already correct) and export a type alias.
print('patch6 applied')
