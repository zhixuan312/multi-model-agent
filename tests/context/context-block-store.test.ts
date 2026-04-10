import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InMemoryContextBlockStore,
  ContextBlockNotFoundError,
} from '../../packages/core/src/context/context-block-store.js';

describe('InMemoryContextBlockStore — basic CRUD', () => {
  it('register-with-id stores content under that id', () => {
    const store = new InMemoryContextBlockStore();
    const result = store.register('hello world', { id: 'greeting' });
    expect(result.id).toBe('greeting');
    expect(result.lengthChars).toBe(11);
    expect(store.get('greeting')).toBe('hello world');
  });

  it('register-without-id generates a UUID', () => {
    const store = new InMemoryContextBlockStore();
    const result = store.register('content');
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get(result.id)).toBe('content');
  });

  it('idempotent re-register under the same id replaces content', () => {
    const store = new InMemoryContextBlockStore();
    store.register('first', { id: 'x' });
    store.register('second', { id: 'x' });
    expect(store.get('x')).toBe('second');
  });

  it('get returns undefined for unknown id', () => {
    const store = new InMemoryContextBlockStore();
    expect(store.get('unknown')).toBeUndefined();
  });

  it('delete returns true if id existed', () => {
    const store = new InMemoryContextBlockStore();
    store.register('content', { id: 'x' });
    expect(store.delete('x')).toBe(true);
    expect(store.delete('x')).toBe(false);
  });

  it('register returns sha256 hash of content', () => {
    const store = new InMemoryContextBlockStore();
    const result = store.register('hello');
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(result.sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('InMemoryContextBlockStore — TTL eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts entries after TTL expires', () => {
    const store = new InMemoryContextBlockStore({ ttlMs: 60_000 });
    store.register('content', { id: 'x' });
    vi.advanceTimersByTime(30_000);
    expect(store.get('x')).toBe('content');
    vi.advanceTimersByTime(31_000);
    expect(store.get('x')).toBeUndefined();
  });
});

describe('InMemoryContextBlockStore — LRU eviction', () => {
  it('evicts least-recently-used when bound is exceeded', () => {
    const store = new InMemoryContextBlockStore({ maxEntries: 3 });
    store.register('a', { id: 'a' });
    store.register('b', { id: 'b' });
    store.register('c', { id: 'c' });
    store.get('a'); // touch a, making b the LRU
    store.register('d', { id: 'd' }); // should evict b
    expect(store.get('a')).toBe('a');
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBe('c');
    expect(store.get('d')).toBe('d');
  });
});

describe('ContextBlockNotFoundError', () => {
  it('carries the missing id and has a helpful message', () => {
    const err = new ContextBlockNotFoundError('missing-id');
    expect(err.id).toBe('missing-id');
    expect(err.message).toContain('missing-id');
    expect(err.name).toBe('ContextBlockNotFoundError');
  });
});
