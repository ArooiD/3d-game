import type { DebugStats } from '../../../shared/types';
import { byId } from '../dom';

/** F3 overlay: performance and simulation counters, refreshed at 4 Hz. */
export class DebugOverlay {
  private node = byId('ui-debug');
  private visible = false;
  private accumulator = 0;
  private frames = 0;
  private frameTime = 0;
  private fps = 0;

  toggle(): void {
    this.visible = !this.visible;
    if (this.node) this.node.classList.toggle('hidden', !this.visible);
  }

  get isOpen(): boolean {
    return this.visible;
  }

  update(dt: number, stats: Omit<DebugStats, 'fps' | 'frameMs'>): void {
    this.frames += 1;
    this.frameTime += dt;
    this.accumulator += dt;
    if (this.accumulator < 0.25) return;
    this.fps = this.frames / this.frameTime;
    const ms = (this.frameTime / this.frames) * 1000;
    this.frames = 0;
    this.frameTime = 0;
    this.accumulator = 0;
    if (!this.visible || !this.node) return;

    this.node.textContent = [
      `FPS ${this.fps.toFixed(1)}  (${ms.toFixed(2)} ms)`,
      `POS ${stats.position.x.toFixed(1)} ${stats.position.y.toFixed(1)} ${stats.position.z.toFixed(1)}`,
      `ENEMIES ${stats.enemiesAlive} alive / ${stats.enemiesActive} spawned`,
      `DRAW CALLS ${stats.drawCalls}  TRIS ${stats.triangles.toLocaleString('en-US')}`,
      `POOLED ${stats.pooledObjects}`,
      `LEVEL ${stats.playerLevel}  STATE ${stats.state}`,
      `WEAPON ${stats.currentWeapon}`,
    ].join('\n');
  }
}
