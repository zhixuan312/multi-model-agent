// Deterministic clock + ID generator for contract tests.
// Replaces `Date.now()` and `crypto.randomUUID()` so goldens stay stable.

let nowMs = 1_700_000_000_000;
let idCounter = 0;

export function freezeClock(atMs = 1_700_000_000_000): void {
  nowMs = atMs;
  idCounter = 0;
}

export function tickMs(delta: number): void {
  nowMs += delta;
}

export function currentMs(): number {
  return nowMs;
}

export function nextId(prefix = 'det'): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(6, '0')}`;
}
