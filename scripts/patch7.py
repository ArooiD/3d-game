"""Fixes the GameApp scaffold: skill cache helper, boss-minion flag, and a few
import/API mismatches found by tsc."""

p = 'src/renderer/app/GameApp.ts'
s = open(p).read()

s = s.replace(
    "import { QuestSystem } from '../game/quests/QuestSystem';",
    "import { QuestSystem } from '../game/quests/QuestSystem';\nimport { skillsFor } from '../data/skills/skills';",
)
s = s.replace(
    """  private playerSkills(): ReturnType<typeof import('../data/skills/skills').skillsFor> {
    return skillsCache(this.player.characterId);
  }""",
    """  private playerSkills(): ReturnType<typeof skillsFor> {
    return skillsFor(this.player.characterId);
  }""",
)
s = s.replace(
    """const RESPAWN_ANCHOR = (world: World): { x: number; y: number; z: number } => world.anchors.playerSpawn;

function skillsCache(characterId: CharacterId) {
  return skillsForCached(characterId);
}
""",
    "const RESPAWN_ANCHOR = (world: World): { x: number; y: number; z: number } => world.anchors.playerSpawn;\n",
)
s = s.replace(
    "import { World, disposeWorldShared } from '../game/world/World';",
    "import { World } from '../game/world/World';",
)
s = s.replace("    disposeWorldShared();\n", "")
s = s.replace("    this.effects.refreshShadows?.();\n", "")
s = s.replace("import { audio, shotSoundFor } from '../game/audio/AudioSystem';", "import { audio } from '../game/audio/AudioSystem';")
s = s.replace("import { INVENTORY_SLOTS, STARTING_RESERVE_MULTIPLIER } from '../../shared/constants';", "import { INVENTORY_SLOTS, STARTING_RESERVE_MULTIPLIER } from '../../shared/constants';")
s = s.replace("import { ACTIVE_SKILLS, CHARACTERS, FRAG, LEVEL_GAINS } from '../data/characters/characters';", "import { ACTIVE_SKILLS, CHARACTERS, FRAG } from '../data/characters/characters';")
s = s.replace("      void LEVEL_GAINS;\n", "")
s = s.replace("import { PROTOTYPE_WEAPON_NAME, QUEST_CLEAR_OUTPOST } from '../data/quests/quests';", "import { PROTOTYPE_WEAPON_NAME } from '../data/quests/quests';")
s = s.replace("import { byId, formatTime, show } from '../ui/dom';", "import { byId, formatTime } from '../ui/dom';")
s = s.replace("import { SaveManager, bridge, isDevelopment } from '../game/core/SaveManager';", "import { SaveManager, isDevelopment } from '../game/core/SaveManager';")
s = s.replace("import { RNG, rng } from '../game/core/Rng';", "import { RNG } from '../game/core/Rng';")
s = s.replace("import type { CharacterId, Rarity, SettingsState, Weapon } from '../../shared/types';", "import type { CharacterId, SettingsState, Weapon } from '../../shared/types';")
s = s.replace("      this.runStats.shotsFired = this.combat.stats.shotsFired;", "      this.runStats.shotsFired = this.combat.stats.shotsFired;")
open(p, 'w').write(s)

# Boss minions need to be flagged so quest/XP accounting can ignore them.
p = 'src/renderer/game/enemies/Enemy.ts'
s = open(p).read()
if 'bossMinion' not in s:
    s = s.replace("  state: EnemyState = 'idle';", "  state: EnemyState = 'idle';\n  /** True for enemies summoned by the mini-boss during phase 2. */\n  bossMinion = false;")
    s = s.replace("        xpReward: this.definition.xpReward,", "        xpReward: this.bossMinion ? Math.round(this.definition.xpReward * 0.4) : this.definition.xpReward,\n        bossMinion: this.bossMinion,")
open(p, 'w').write(s)

# EnemyManager: carry the flag from the spawn request onto the entity.
p = 'src/renderer/game/enemies/EnemyManager.ts'
s = open(p).read()
if 'enemy.bossMinion' not in s:
    s = s.replace("    enemy.place(request.x, y, request.z);", "    enemy.place(request.x, y, request.z);\n    enemy.bossMinion = Boolean(request.bossMinion);")
open(p, 'w').write(s)

print('patch7 applied')
