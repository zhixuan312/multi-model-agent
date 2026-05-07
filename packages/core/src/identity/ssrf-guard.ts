const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc/,
  /^fe80:/,
];

export class SSRFGuard {
  check(url: string): void {
    const u = new URL(url);
    if (PRIVATE_RANGES.some(rx => rx.test(u.hostname))) {
      throw new Error(`SSRF: private range ${u.hostname}`);
    }
  }
}
