export class Supervisor {
  private stallCount = 0;
  private lastEventAtMs = Date.now();

  observe(): void {
    this.lastEventAtMs = Date.now();
  }

  isStalled(thresholdMs: number): boolean {
    return Date.now() - this.lastEventAtMs > thresholdMs;
  }

  getStallCount(): number {
    return this.stallCount;
  }

  incStall(): void {
    this.stallCount++;
  }
}
