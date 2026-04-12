export interface CostMeterOptions {
  ceiling?: number;
}

export class CostMeter {
  private spent: number = 0;
  private readonly ceiling: number;

  constructor(options: CostMeterOptions = {}) {
    this.ceiling = options.ceiling ?? Infinity;
  }

  add(amount: number): void {
    this.spent += amount;
  }

  total(): number {
    return this.spent;
  }

  canProceed(nextCost: number): boolean {
    return this.spent + nextCost <= this.ceiling;
  }

  remaining(): number {
    return Math.max(0, this.ceiling - this.spent);
  }
}
