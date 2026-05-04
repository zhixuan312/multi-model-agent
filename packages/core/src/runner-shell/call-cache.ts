export class CallCache {
  private store = new Map<string, unknown>();

  key(toolName: string, input: unknown): string {
    return `${toolName}::${JSON.stringify(input)}`;
  }

  has(toolName: string, input: unknown): boolean {
    return this.store.has(this.key(toolName, input));
  }

  get(toolName: string, input: unknown): unknown {
    return this.store.get(this.key(toolName, input));
  }

  set(toolName: string, input: unknown, result: unknown): void {
    this.store.set(this.key(toolName, input), result);
  }
}
