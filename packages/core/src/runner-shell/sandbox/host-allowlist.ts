export class HostAllowlist {
  constructor(private allowed: Set<string>) {}

  check(host: string): void {
    if (!this.allowed.has(host)) throw new Error(`host not allowed: ${host}`);
  }
}
