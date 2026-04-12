export interface CachedEntry<T> {
  result: T;
  cachedAt: number;
}

export class CallCache {
  private store = new Map<string, CachedEntry<any>>();
  private scopes = new Map<string, CallCache>();

  get(key: string): any | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const { cachedAt, ...result } = entry;
    return result;
  }

  set(key: string, entry: { result: any }): void {
    this.store.set(key, { ...entry, cachedAt: Date.now() });
  }

  evict(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.scopes.clear();
  }

  scope(name: string): CallCache {
    if (!this.scopes.has(name)) {
      this.scopes.set(name, new CallCache());
    }
    return this.scopes.get(name)!;
  }
}
