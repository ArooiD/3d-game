import re

# WeaponController: sound key rename, drop unused fields, unused ctor param.
p = 'src/renderer/game/weapons/WeaponController.ts'
s = open(p).read()
s = s.replace("SoundName.EmptyClick", "SoundName.DryFire")
s = s.replace("  private gunMesh: THREE.Mesh | null = null;\n", "")
s = s.replace("    this.gunMesh = gun;\n", "")
s = s.replace("    this.gunMesh = null;\n", "")
s = s.replace("    private scene: THREE.Scene,\n", "    _scene: THREE.Scene,\n")
s = s.replace("    if (!camera.parent) scene.add(camera);", "    if (!camera.parent) _scene.add(camera);")
s = s.replace("  private allocateSlot(weapon: Weapon): number {", "  private allocateSlot(): number {")
s = s.replace("this.allocateSlot(weapon)", "this.allocateSlot()")
open(p, 'w').write(s)

# Enemy: audio.playAt signature is (name, distance, maxDistance, throttleMs).
p = 'src/renderer/game/enemies/Enemy.ts'
s = open(p).read()
s = s.replace("    audio.playAt(SoundName.EnemyAlert, 0, 34, 400);\n", "")
s = s.replace("          this.becomeAlerted();", "          this.becomeAlerted();\n          audio.playAt(SoundName.EnemyAlert, flatDistance, 45, 400);")
s = s.replace("audio.playAt('weapon_shot_rifle', 0, 55, 45);", "audio.playAt('weapon_shot_rifle', this.distanceTo(context.playerPosition), 70, 30);")
s = s.replace("audio.playAt(SoundName.Explosion, 0, 70);", "audio.playAt(SoundName.Explosion, this.distanceTo(context.playerPosition), 90);")
if 'function flatDist' not in s:
    s = s.rstrip() + """

function flatDist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
"""
open(p, 'w').write(s)

# EnemyManager: audio import usage + distance-aware drop cue.
p = 'src/renderer/game/enemies/EnemyManager.ts'
s = open(p).read()
s = s.replace("      if (payload.position) {\n        audio.playAt(SoundName.LootDrop, 0, 60);\n      }",
              "      if (payload.position) {\n        audio.playAt(SoundName.LootDrop, this.distanceFromCamera(payload.position), 70);\n      }")
if 'distanceFromCamera' not in s.split('attach')[0]:
    s = s.replace("  private cameraPos(): THREE.Vector3 {\n    return this.camera.position;\n  }",
                  "  private cameraPos(): THREE.Vector3 {\n    return this.camera.position;\n  }\n\n  private distanceFromCamera(point: THREE.Vector3): number {\n    return point.distanceTo(this.camera.position);\n  }")
open(p, 'w').write(s)

print('patch3 applied')
