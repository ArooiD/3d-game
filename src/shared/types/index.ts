/**
 * Shared type definitions used by both the Electron main process and the renderer.
 * Keep this file free of runtime imports so it can be bundled anywhere.
 */

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export type WeaponType = 'pistol' | 'assault_rifle' | 'shotgun' | 'sniper_rifle' | 'smg';

export type CharacterId = 'vanguard' | 'ranger' | 'engineer';

export type SkillBranch = 'offense' | 'defense' | 'utility';

export type EnemyBehavior = 'raider' | 'rusher' | 'heavy' | 'sniper' | 'boss';

export type ModifierStat =
  | 'damage'
  | 'fireRate'
  | 'magazineSize'
  | 'reloadTime'
  | 'accuracy'
  | 'recoil'
  | 'criticalMultiplier'
  | 'projectiles'
  | 'shieldDamage'
  | 'range';

/** A single procedurally applied stat change on a weapon. */
export interface WeaponModifier {
  stat: ModifierStat;
  /** Multiplicative for most stats, flat additive for `projectiles`. */
  value: number;
  /** Human readable label, e.g. "+15% Damage". */
  label: string;
}

/** Stats that drive weapon feel. Filled from data + generator, persisted per weapon. */
export interface WeaponStats {
  damage: number;
  fireRate: number;
  magazineSize: number;
  reloadTime: number;
  accuracy: number;
  recoil: number;
  criticalMultiplier: number;
  pellets: number;
  spread: number;
  range: number;
  projectileSpeed: number;
  shieldDamageBonus: number;
  /** Full-auto fire while the trigger is held. */
  auto: boolean;
  /** Screen shake impulse on fire. */
  shake: number;
  /** Fraction of damage removed past 60% of effective range. */
  falloff: number;
  /** Field of view divider while aiming down sights. */
  adsZoom: number;
  /** Model tint + size for the first-person viewmodel. */
  modelColor: number;
  modelScale: [number, number, number];
}

export interface Weapon extends WeaponStats {
  /** Base template id, e.g. "assault_rifle". */
  id: string;
  /** Globally unique instance id used by inventory and save files. */
  uid: string;
  name: string;
  weaponType: WeaponType;
  rarity: Rarity;
  level: number;
  modifiers: WeaponModifier[];
  /** Runtime state, persisted: rounds in magazine and in reserve. */
  ammo: number;
  reserveAmmo: number;
}

export interface CharacterBaseStats {
  maxHealth: number;
  maxShield: number;
  movementSpeed: number;
  sprintSpeed: number;
  criticalChance: number;
  criticalDamage: number;
  weaponDamageModifier: number;
  skillCooldownModifier: number;
}

export interface CharacterDefinition {
  id: CharacterId;
  name: string;
  tagline: string;
  description: string;
  specialties: string[];
  preferredWeapons: WeaponType[];
  startingWeapon: WeaponType;
  stats: CharacterBaseStats;
  activeSkillId: string;
  colorHex: number;
}

export type SkillEffectStat =
  | 'weaponDamage'
  | 'maxShield'
  | 'maxHealth'
  | 'movementSpeed'
  | 'criticalDamage'
  | 'criticalChance'
  | 'reloadTime'
  | 'fireRate'
  | 'shieldRegenDelay'
  | 'cooldown'
  | 'ammoReserve'
  | 'damageResist';

export interface SkillDefinition {
  id: string;
  characterId: CharacterId;
  branch: SkillBranch;
  name: string;
  description: string;
  maxRanks: number;
  effect: { stat: SkillEffectStat; perRank: number; unit: 'percent' | 'flat' };
  requires?: string;
  tier: number;
}

export interface EnemyDefinition {
  id: string;
  name: string;
  behavior: EnemyBehavior;
  health: number;
  shield: number;
  damage: number;
  moveSpeed: number;
  /** Preferred stand-off distance in meters. */
  preferredRange: number;
  detectionRadius: number;
  attackInterval: number;
  attackRange: number;
  xpReward: number;
  height: number;
  radius: number;
  colorHex: number;
  accentHex: number;
  isElite?: boolean;
  lootChance: number;
}

export type QuestStepType = 'goto' | 'kill' | 'collect';

export interface QuestStepState {
  id: string;
  text: string;
  type: QuestStepType;
  target?: string;
  required?: number;
  progress?: number;
  position?: { x: number; z: number };
  radius?: number;
  completed: boolean;
}

export interface QuestState {
  id: string;
  name: string;
  currentStep: number;
  steps: QuestStepState[];
  completed: boolean;
}

export interface SettingsState {
  sensitivity: number;
  invertY: boolean;
  fov: number;
  masterVolume: number;
  showDamageNumbers: boolean;
  screenShake: number;
  quality: 'low' | 'medium' | 'high';
}

export interface SaveGame {
  version: number;
  createdAt: number;
  updatedAt: number;
  playtimeSeconds: number;
  character: {
    characterId: CharacterId;
    name: string;
    level: number;
    xp: number;
    health: number;
    shield: number;
    skillPoints: number;
  };
  progression: {
    skills: Record<string, number>;
  };
  inventory: Weapon[];
  equipped: (Weapon | null)[];
  quests: Record<string, QuestState>;
  stats: {
    enemiesKilled: number;
    bossesKilled: number;
    weaponsFound: number;
    shotsFired: number;
    shotsHit: number;
  };
  settings: SettingsState;
  playerPosition?: { x: number; y: number; z: number };
  playerYaw?: number;
  clearedGroups?: string[];
}

export interface SaveSummary {
  fileName: string;
  version: number;
  characterId: CharacterId;
  characterName: string;
  level: number;
  playtimeSeconds: number;
  updatedAt: number;
  questText: string;
}

export interface DebugStats {
  fps: number;
  frameMs: number;
  position: { x: number; y: number; z: number };
  enemiesAlive: number;
  enemiesActive: number;
  drawCalls: number;
  triangles: number;
  playerLevel: number;
  currentWeapon: string;
  pooledObjects: number;
  state: string;
}

export const IPC_CHANNELS = {
  saveGame: 'game:save',
  loadGame: 'game:load',
  listSaves: 'game:list-saves',
  deleteSave: 'game:delete-save',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  quitApp: 'app:quit',
  isDev: 'app:is-dev',
} as const;

/** API surface exposed on `window.gameApi` by the preload script. */
export interface GameBridge {
  isDev: boolean;
  saveGame: (fileName: string, data: SaveGame) => Promise<{ ok: boolean; error?: string }>;
  loadGame: (fileName: string) => Promise<SaveGame | null>;
  listSaves: () => Promise<SaveSummary[]>;
  deleteSave: (fileName: string) => Promise<{ ok: boolean }>;
  getSettings: () => Promise<Partial<SettingsState> | null>;
  setSettings: (settings: SettingsState) => Promise<{ ok: boolean }>;
  quit: () => Promise<void>;
}
