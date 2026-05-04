export class IdleGuard {
  private lastModelSignalMs = Date.now();

  constructor(private idleBudgetMs: number) {}

  resetOnModelSignal(): void {
    this.lastModelSignalMs = Date.now();
  }

  checkOrThrow(): void {
    if (Date.now() - this.lastModelSignalMs > this.idleBudgetMs) {
      const e: any = new Error(`idle budget exceeded (${this.idleBudgetMs}ms)`);
      e.errorCode = 'lifecycle_idle_exceeded';
      throw e;
    }
  }
}
