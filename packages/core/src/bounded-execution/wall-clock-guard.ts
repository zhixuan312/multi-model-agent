class GuardError extends Error {
  constructor(message: string, public errorCode: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export class WallClockGuard {
  private startedAtMs: number;

  constructor(private budgetMs: number) {
    if (!(budgetMs >= 0)) throw new Error('budgetMs must be >= 0');
    this.startedAtMs = performance.now();
  }

  checkOrThrow(): void {
    if (performance.now() - this.startedAtMs > this.budgetMs) {
      throw new GuardError(
        `wall-clock budget exceeded (${this.budgetMs}ms)`,
        'guard_wall_clock',
      );
    }
  }

  remaining(): number {
    return Math.max(0, this.budgetMs - (performance.now() - this.startedAtMs));
  }
}
