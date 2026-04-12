import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallCache } from '@zhixuan92/multi-model-agent-core/tools/call-cache';

describe('CallCache', () => {
  let cache: CallCache;

  beforeEach(() => {
    cache = new CallCache();
  });

  it('miss on empty cache', () => {
    expect(cache.get('key1')).toBeNull();
  });

  it('hit after set', () => {
    cache.set('key1', { result: 'value1' });
    expect(cache.get('key1')).toEqual({ result: 'value1' });
  });

  it('evict removes entry', () => {
    cache.set('key1', { result: 'value1' });
    cache.evict('key1');
    expect(cache.get('key1')).toBeNull();
  });

  it('clear removes all entries', () => {
    cache.set('key1', { result: 'value1' });
    cache.set('key2', { result: 'value2' });
    cache.clear();
    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key2')).toBeNull();
  });

  it('scope isolates entries', () => {
    const scope1 = cache.scope('scope1');
    const scope2 = cache.scope('scope2');
    scope1.set('key', { result: 'scope1-value' });
    scope2.set('key', { result: 'scope2-value' });
    expect(scope1.get('key')).toEqual({ result: 'scope1-value' });
    expect(scope2.get('key')).toEqual({ result: 'scope2-value' });
  });
});
