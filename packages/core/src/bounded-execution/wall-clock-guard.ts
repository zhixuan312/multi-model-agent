export class WallClockGuard {
  private startedAtMs: number;
  constructor(private budgetMs: number) {
    this.startedAtMs = Date.now();
  }
  checkOrThrow(): void {
    if (Date.now() - this.startedAtMs > this.budgetMs) {
      const e: any = new Error(`wall-clock budget exceeded (${this.budgetMs}ms)`);
      e.errorCode = 'lifecycle_wall_clock_exceeded';
      throw e;
    }
  }
  remaining(): number { return Math.max(0, this.budgetMs - (Date.now() - this.startedAtMs)); }
}
