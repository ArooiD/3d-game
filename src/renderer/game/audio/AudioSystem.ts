
/**
 * Procedural sound. There are no audio files in the repo, so every effect is
 * synthesised with WebAudio on demand. Callers only ever reference a logical
 * name from the SoundName table, so real samples can be dropped in later without
 * touching gameplay code — and a missing/blocked AudioContext silently disables
 * audio instead of breaking the game.
 */

export const SoundName = {
  PistolShot: 'weapon_shot_pistol',
  RifleShot: 'weapon_shot_rifle',
  ShotgunShot: 'weapon_shot_shotgun',
  SniperShot: 'weapon_shot_sniper',
  SmgShot: 'weapon_shot_smg',
  Reload: 'weapon_reload',
  DryFire: 'weapon_dry',
  EnemyHit: 'enemy_hit',
  CritHit: 'enemy_crit',
  EnemyDeath: 'enemy_death',
  EnemyAlert: 'enemy_alert',
  PlayerHurt: 'player_hurt',
  ShieldBreak: 'shield_break',
  ShieldUp: 'shield_regen',
  LootDrop: 'loot_drop',
  LootPickup: 'loot_pickup',
  LootRare: 'loot_rare',
  LevelUp: 'level_up',
  BossSpawn: 'boss_spawn',
  BossPhase: 'boss_phase',
  BossDeath: 'boss_death',
  Explosion: 'explosion',
  Ability: 'ability_used',
  UISelect: 'ui_select',
  UIBack: 'ui_back',
  Objective: 'objective',
} as const;

export type SoundNameValue = (typeof SoundName)[keyof typeof SoundName];

interface Voice {
  type: OscillatorType;
  freqFrom: number;
  freqTo?: number;
  duration: number;
  gain: number;
  delay?: number;
  filter?: { type: BiquadFilterType; from: number; to?: number; q?: number };
  noise?: boolean;
}

interface SoundRecipe {
  voices: Voice[];
  /** Random pitch jitter applied to every voice, in semitone-ish units. */
  jitter?: number;
}

const RECIPES: Record<string, SoundRecipe> = {
  [SoundName.PistolShot]: {
    jitter: 0.12,
    voices: [
      { type: 'square', freqFrom: 420, freqTo: 90, duration: 0.09, gain: 0.3 },
      { type: 'sawtooth', freqFrom: 1800, freqTo: 400, duration: 0.05, gain: 0.18 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.07, gain: 0.4, filter: { type: 'highpass', from: 900 } },
    ],
  },
  [SoundName.RifleShot]: {
    jitter: 0.1,
    voices: [
      { type: 'square', freqFrom: 300, freqTo: 70, duration: 0.11, gain: 0.32 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.09, gain: 0.45, filter: { type: 'bandpass', from: 1600, to: 500, q: 0.9 } },
    ],
  },
  [SoundName.SmgShot]: {
    jitter: 0.16,
    voices: [
      { type: 'square', freqFrom: 520, freqTo: 150, duration: 0.05, gain: 0.2 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.045, gain: 0.3, filter: { type: 'highpass', from: 1400 } },
    ],
  },
  [SoundName.ShotgunShot]: {
    jitter: 0.07,
    voices: [
      { type: 'sawtooth', freqFrom: 220, freqTo: 45, duration: 0.26, gain: 0.42 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.3, gain: 0.5, filter: { type: 'lowpass', from: 3200, to: 400, q: 0.7 } },
    ],
  },
  [SoundName.SniperShot]: {
    jitter: 0.05,
    voices: [
      { type: 'sawtooth', freqFrom: 160, freqTo: 32, duration: 0.5, gain: 0.45 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.55, gain: 0.4, filter: { type: 'lowpass', from: 5000, to: 300 } },
      { type: 'sine', freqFrom: 900, freqTo: 200, duration: 0.3, gain: 0.12, delay: 0.04 },
    ],
  },
  [SoundName.Reload]: {
    voices: [
      { type: 'square', freqFrom: 180, freqTo: 120, duration: 0.05, gain: 0.16 },
      { type: 'square', freqFrom: 240, freqTo: 150, duration: 0.05, gain: 0.16, delay: 0.16 },
      { type: 'square', freqFrom: 320, freqTo: 200, duration: 0.07, gain: 0.2, delay: 0.42 },
    ],
  },
  [SoundName.DryFire]: {
    voices: [{ type: 'square', freqFrom: 900, freqTo: 500, duration: 0.04, gain: 0.12 }],
  },
  [SoundName.EnemyHit]: {
    jitter: 0.2,
    voices: [{ type: 'triangle', freqFrom: 700, freqTo: 380, duration: 0.07, gain: 0.16 }],
  },
  [SoundName.CritHit]: {
    voices: [
      { type: 'triangle', freqFrom: 1300, freqTo: 700, duration: 0.1, gain: 0.2 },
      { type: 'sine', freqFrom: 2000, freqTo: 1200, duration: 0.12, gain: 0.1, delay: 0.02 },
    ],
  },
  [SoundName.EnemyDeath]: {
    jitter: 0.15,
    voices: [
      { type: 'sawtooth', freqFrom: 260, freqTo: 60, duration: 0.32, gain: 0.22 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.3, gain: 0.2, filter: { type: 'lowpass', from: 1400, to: 250 } },
    ],
  },
  [SoundName.EnemyAlert]: {
    voices: [{ type: 'square', freqFrom: 500, freqTo: 760, duration: 0.12, gain: 0.14 }],
  },
  [SoundName.PlayerHurt]: {
    voices: [
      { type: 'sawtooth', freqFrom: 150, freqTo: 70, duration: 0.22, gain: 0.3 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.16, gain: 0.22, filter: { type: 'lowpass', from: 900 } },
    ],
  },
  [SoundName.ShieldBreak]: {
    voices: [
      { type: 'square', freqFrom: 900, freqTo: 180, duration: 0.24, gain: 0.2 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.28, gain: 0.24, filter: { type: 'bandpass', from: 2600, to: 700, q: 2 } },
    ],
  },
  [SoundName.ShieldUp]: {
    voices: [{ type: 'sine', freqFrom: 500, freqTo: 1000, duration: 0.3, gain: 0.1 }],
  },
  [SoundName.LootDrop]: {
    voices: [
      { type: 'sine', freqFrom: 800, freqTo: 500, duration: 0.14, gain: 0.12 },
      { type: 'sine', freqFrom: 1200, freqTo: 800, duration: 0.1, gain: 0.08, delay: 0.05 },
    ],
  },
  [SoundName.LootPickup]: {
    voices: [
      { type: 'sine', freqFrom: 700, freqTo: 1400, duration: 0.14, gain: 0.16 },
      { type: 'triangle', freqFrom: 1400, freqTo: 2100, duration: 0.12, gain: 0.1, delay: 0.08 },
    ],
  },
  [SoundName.LootRare]: {
    voices: [
      { type: 'sine', freqFrom: 660, freqTo: 990, duration: 0.16, gain: 0.16 },
      { type: 'sine', freqFrom: 990, freqTo: 1320, duration: 0.16, gain: 0.14, delay: 0.1 },
      { type: 'sine', freqFrom: 1320, freqTo: 1980, duration: 0.24, gain: 0.12, delay: 0.2 },
    ],
  },
  [SoundName.LevelUp]: {
    voices: [
      { type: 'triangle', freqFrom: 523, freqTo: 523, duration: 0.14, gain: 0.18 },
      { type: 'triangle', freqFrom: 659, freqTo: 659, duration: 0.14, gain: 0.18, delay: 0.11 },
      { type: 'triangle', freqFrom: 784, freqTo: 784, duration: 0.2, gain: 0.18, delay: 0.22 },
      { type: 'sine', freqFrom: 1046, freqTo: 1046, duration: 0.4, gain: 0.12, delay: 0.33 },
    ],
  },
  [SoundName.BossSpawn]: {
    voices: [
      { type: 'sawtooth', freqFrom: 70, freqTo: 44, duration: 1.6, gain: 0.4 },
      { type: 'square', freqFrom: 140, freqTo: 88, duration: 1.3, gain: 0.18 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 1.4, gain: 0.2, filter: { type: 'lowpass', from: 500, to: 120 } },
    ],
  },
  [SoundName.BossPhase]: {
    voices: [
      { type: 'square', freqFrom: 110, freqTo: 330, duration: 0.6, gain: 0.26 },
      { type: 'sawtooth', freqFrom: 55, freqTo: 165, duration: 0.9, gain: 0.26 },
    ],
  },
  [SoundName.BossDeath]: {
    voices: [
      { type: 'sawtooth', freqFrom: 220, freqTo: 40, duration: 1.5, gain: 0.36 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 1.6, gain: 0.3, filter: { type: 'lowpass', from: 2600, to: 120 } },
    ],
  },
  [SoundName.Explosion]: {
    voices: [
      { type: 'sawtooth', freqFrom: 130, freqTo: 30, duration: 0.5, gain: 0.4 },
      { noise: true, type: 'sawtooth', freqFrom: 0, duration: 0.6, gain: 0.42, filter: { type: 'lowpass', from: 4000, to: 200 } },
    ],
  },
  [SoundName.Ability]: {
    voices: [
      { type: 'square', freqFrom: 320, freqTo: 900, duration: 0.2, gain: 0.18 },
      { type: 'sine', freqFrom: 900, freqTo: 1500, duration: 0.22, gain: 0.1, delay: 0.06 },
    ],
  },
  [SoundName.UISelect]: {
    voices: [{ type: 'square', freqFrom: 700, freqTo: 900, duration: 0.05, gain: 0.1 }],
  },
  [SoundName.UIBack]: {
    voices: [{ type: 'square', freqFrom: 500, freqTo: 320, duration: 0.06, gain: 0.1 }],
  },
  [SoundName.Objective]: {
    voices: [
      { type: 'sine', freqFrom: 880, freqTo: 880, duration: 0.12, gain: 0.14 },
      { type: 'sine', freqFrom: 1320, freqTo: 1320, duration: 0.2, gain: 0.12, delay: 0.1 },
    ],
  },
};

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastPlayed = new Map<string, number>();
  /** Global output level 0..1 from settings. */
  private volume = 0.7;
  private muted = false;
  private failed = false;
  private voiceBudget = 0;
  private budgetTimer = 0;

  /** Must be triggered from a user gesture (Electron autoplay policy). */
  unlock(): void {
    if (this.failed) return;
    if (!this.context) {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return;
        }
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        // Gentle limiter so stacked gunfire does not clip.
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.ratio.value = 8;
        this.master.connect(compressor);
        compressor.connect(this.context.destination);
        this.noiseBuffer = this.createNoiseBuffer(this.context);
      } catch (err) {
        console.warn('[audio] unavailable, continuing silently', err);
        this.failed = true;
        return;
      }
    }
    if (this.context.state === 'suspended') void this.context.resume();
  }

  private createNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 0.7);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 0.5;
    }
    return buffer;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  get isAvailable(): boolean {
    return !this.failed && this.context !== null;
  }

  /**
   * Play a logical sound. `intensity` scales gain (used for distance falloff)
   * and `throttleMs` collapses duplicate triggers from bursts of fire.
   */
  play(name: SoundNameValue | string, intensity = 1, throttleMs = 0, detune = 0): void {
    if (this.failed || this.muted || intensity <= 0.02) return;
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master) return;
    if (ctx.state === 'suspended') return;

    const now = ctx.currentTime;
    if (throttleMs > 0) {
      const last = this.lastPlayed.get(name) ?? -1;
      if (now - last < throttleMs / 1000) return;
      this.lastPlayed.set(name, now);
    }

    // Keep a hard cap on simultaneous voices for very fast SMG fire.
    this.budgetTimer -= 1;
    if (this.budgetTimer <= 0) {
      this.budgetTimer = 4;
      this.voiceBudget = 0;
    }
    if (this.voiceBudget > 14) return;
    this.voiceBudget += 1;

    const recipe = RECIPES[name];
    if (!recipe) return;
    const jitter = 1 + (Math.random() - 0.5) * (recipe.jitter ?? 0);

    for (const voice of recipe.voices) {
      const start = now + (voice.delay ?? 0);
      const gainNode = ctx.createGain();
      const peak = Math.max(0.0001, voice.gain * intensity * this.volume);
      gainNode.gain.setValueAtTime(0.0001, start);
      gainNode.gain.exponentialRampToValueAtTime(peak, start + 0.006);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, start + voice.duration);

      let tail: AudioNode = gainNode;
      if (voice.filter) {
        const filter = ctx.createBiquadFilter();
        filter.type = voice.filter.type;
        filter.frequency.setValueAtTime(voice.filter.from, start);
        if (voice.filter.to !== undefined) {
          filter.frequency.exponentialRampToValueAtTime(Math.max(40, voice.filter.to), start + voice.duration);
        }
        filter.Q.value = voice.filter.q ?? 1;
        gainNode.connect(filter);
        tail = filter;
      }
      tail.connect(master);

      if (voice.noise && this.noiseBuffer) {
        const source = ctx.createBufferSource();
        source.buffer = this.noiseBuffer;
        source.playbackRate.value = Math.max(0.3, jitter + detune);
        source.connect(gainNode);
        source.start(start);
        source.stop(start + voice.duration + 0.02);
        source.onended = () => {
          source.disconnect();
          gainNode.disconnect();
        };
      } else {
        const osc = ctx.createOscillator();
        osc.type = voice.type;
        const from = Math.max(20, voice.freqFrom * jitter * (1 + detune));
        const to = Math.max(20, (voice.freqTo ?? voice.freqFrom) * jitter * (1 + detune));
        osc.frequency.setValueAtTime(from, start);
        osc.frequency.exponentialRampToValueAtTime(to, start + voice.duration);
        osc.connect(gainNode);
        osc.start(start);
        osc.stop(start + voice.duration + 0.02);
        osc.onended = () => {
          osc.disconnect();
          gainNode.disconnect();
        };
      }
    }
  }

  /** Attenuate by distance for world-positioned sounds. */
  playAt(name: SoundNameValue | string, distance: number, maxDistance = 60, throttleMs = 0): void {
    if (distance > maxDistance) return;
    const falloff = 1 - distance / maxDistance;
    this.play(name, Math.max(0.05, falloff * falloff), throttleMs);
  }

  dispose(): void {
    if (this.context) {
      void this.context.close().catch(() => undefined);
      this.context = null;
      this.master = null;
      this.noiseBuffer = null;
    }
  }
}

export const audio = new AudioSystem();

/** Map a weapon type to its report. */
export function shotSoundFor(weaponType: string): SoundNameValue {
  switch (weaponType) {
    case 'pistol':
      return SoundName.PistolShot;
    case 'assault_rifle':
      return SoundName.RifleShot;
    case 'shotgun':
      return SoundName.ShotgunShot;
    case 'sniper_rifle':
      return SoundName.SniperShot;
    case 'smg':
      return SoundName.SmgShot;
    default:
      return SoundName.RifleShot;
  }
}
