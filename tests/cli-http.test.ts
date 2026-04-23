import { describe, it, expect } from 'vitest';
import { parseHttpFlags } from '../packages/mcp/src/cli.js';

describe('parseHttpFlags', () => {
  it('returns undefined when --http is not present', () => {
    expect(parseHttpFlags(['serve'])).toBeUndefined();
  });

  it('enables http mode with defaults when --http is present', () => {
    const r = parseHttpFlags(['serve', '--http'])!;
    expect(r.mode).toBe('http');
    expect(r.port).toBeUndefined();
    expect(r.bind).toBeUndefined();
  });

  it('captures --port and --bind overrides', () => {
    const r = parseHttpFlags(['serve', '--http', '--port', '9999', '--bind', '127.0.0.1'])!;
    expect(r.port).toBe(9999);
    expect(r.bind).toBe('127.0.0.1');
  });

  it('rejects negative port', () => {
    expect(() => parseHttpFlags(['serve', '--http', '--port', '-1'])).toThrow();
  });
});
