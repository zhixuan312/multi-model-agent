/**
 * `RouteDispatcher` decides which handler serves a request, and had no test of its own — it was
 * exercised only incidentally, through servers booted for other reasons. That left its actual
 * contract (what a `:param` captures, what a literal segment means, what `methodsFor` reports)
 * unstated anywhere an assertion could check.
 */
import { describe, expect, it } from 'vitest';
import { RouteDispatcher } from '../../packages/core/src/transport/route-dispatcher.js';

const handler = (name: string) => name;

describe('RouteDispatcher — literal segments are literal', () => {
  /**
   * `register` used to build its pattern by replacing only `:param`, leaving every other regex
   * metacharacter live. A `.` in a path therefore meant "any character", so `/openapi.json` would
   * have served `/openapiXjson` as well. No route registered today contains a metacharacter, which
   * is why this had not bitten: the failure mode is a silent mis-route rather than an error, so it
   * would have arrived with whichever route first needed a dot.
   */
  it('a dot in a path matches only a dot', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/openapi.json', handler('spec'));

    expect(r.match('GET', '/openapi.json')?.handler).toBe('spec');
    expect(r.match('GET', '/openapiXjson')).toBeNull();
  });

  it('other metacharacters are literal too', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/a+b', handler('plus'));
    expect(r.match('GET', '/a+b')?.handler).toBe('plus');
    expect(r.match('GET', '/aaab')).toBeNull();
  });
});

describe('RouteDispatcher — parameters', () => {
  it('captures a named parameter', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/execution/:executionId', handler('poll'));
    const m = r.match('GET', '/execution/abc-123');
    expect(m?.handler).toBe('poll');
    expect(m?.params).toEqual({ executionId: 'abc-123' });
  });

  it('a parameter never swallows a slash', () => {
    // What keeps `/execution/:id` from also serving `/execution/:id/artifact`.
    const r = new RouteDispatcher<string>();
    r.register('GET', '/execution/:executionId', handler('poll'));
    expect(r.match('GET', '/execution/abc/artifact')).toBeNull();
  });

  it('distinguishes the bare path from the parameterised one', () => {
    const r = new RouteDispatcher<string>();
    r.register('POST', '/execution', handler('submit'));
    r.register('GET', '/execution/:executionId', handler('poll'));
    expect(r.match('POST', '/execution')?.handler).toBe('submit');
    expect(r.match('POST', '/execution/abc')).toBeNull();
    expect(r.match('GET', '/execution')).toBeNull();
  });

  it('ignores the query string when matching', () => {
    const r = new RouteDispatcher<string>();
    r.register('POST', '/execution', handler('submit'));
    expect(r.match('POST', '/execution?cwd=%2Ftmp')?.handler).toBe('submit');
  });

  it('returns null for an unregistered method on a registered path', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/health', handler('health'));
    expect(r.match('DELETE', '/health')).toBeNull();
  });
});

describe('RouteDispatcher — introspection', () => {
  it('methodsFor reports every method serving a path, which is what a 405 Allow header carries', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/execution/:executionId', handler('poll'));
    r.register('DELETE', '/execution/:executionId', handler('cancel'));
    r.register('POST', '/execution', handler('submit'));

    expect(r.methodsFor('/execution/abc').sort()).toEqual(['DELETE', 'GET']);
    expect(r.methodsFor('/execution')).toEqual(['POST']);
    expect(r.methodsFor('/nowhere')).toEqual([]);
  });

  it('listRoutes returns the registered manifest', () => {
    const r = new RouteDispatcher<string>();
    r.register('GET', '/health', handler('health'));
    r.register('POST', '/execution', handler('submit'));
    expect(r.listRoutes()).toEqual([
      { method: 'GET', path: '/health' },
      { method: 'POST', path: '/execution' },
    ]);
  });

  it('re-registering a method+path replaces the handler rather than adding a second', () => {
    // Relied on by the server's agents-configured/not branches, which register the same paths
    // in mutually exclusive arms; worth pinning so a future third registration is a visible
    // decision rather than a silent last-one-wins.
    const r = new RouteDispatcher<string>();
    r.register('POST', '/execution', handler('first'));
    r.register('POST', '/execution', handler('second'));
    expect(r.match('POST', '/execution')?.handler).toBe('second');
    expect(r.listRoutes()).toHaveLength(1);
  });
});
