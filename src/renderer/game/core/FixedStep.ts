/** Fixed 60 Hz gameplay with bounded catch-up after stalls. */
export class FixedStep {
  private accumulator = 0;
  constructor(readonly dt = 1 / 60, readonly maxSteps = 8) {}
  reset(): void { this.accumulator = 0; }
  advance(elapsed: number, tick: (dt: number) => void): number {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
    this.accumulator = Math.min(this.accumulator + elapsed, this.dt * this.maxSteps);
    let steps = 0;
    while (this.accumulator + 1e-10 >= this.dt && steps < this.maxSteps) {
      this.accumulator -= this.dt;
      tick(this.dt);
      steps++;
    }
    return steps;
  }
}
