/**
 * Deterministic, seedable PRNG (mulberry32) plus the random helpers the game
 * uses. One global instance is re-seeded on new game so runs are reproducible
 * when a seed is supplied.
 */

export class RNG {
  private state: number;

  constructor(seed: number = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0) {
    this.state = seed >>> 0;
  }

  reseed(seed: number): void {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('RNG.pick on empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick `count` distinct entries (Fisher-Yates prefix). */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = items.slice();
    for (let i = 0; i < count && i < pool.length; i++) {
      const j = i + Math.floor(this.next() * (pool.length - i));
      const tmp = pool[i] as T;
      pool[i] = pool[j] as T;
      pool[j] = tmp;
    }
    return pool.slice(0, Math.min(count, pool.length));
  }

  /**
   * Weighted pick. `weights` must line up with `items`.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('RNG.weighted on empty array');
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.pick(items);
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i] ?? 0);
      if (roll <= 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /** Symmetric around 0, roughly bell shaped (sum of two uniforms). */
  spread(): number {
    return (this.next() + this.next() - 1) as number;
  }

  /** Random unit vector on the XZ plane. */
  angle(): number {
    return this.next() * Math.PI * 2;
  }

  id(prefix = 'id'): string {
    return `${prefix}_${Math.floor(this.next() * 0xffffff).toString(36)}_${uidTail()}`;
  }
}

let idCounter = 0;

function uidTail(): string {
  idCounter += 1;
  return idCounter.toString(36);
}

/** Shared gameplay RNG (loot, AI jitter, effects). */
export const rng = new RNG();

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, smoothTime: number, dt: number): number {
  const t = 1 - Math.exp(-dt / Math.max(0.0001, smoothTime));
  return lerp(current, target, t);
}

export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
