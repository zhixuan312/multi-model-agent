import { describe, it, expect } from 'vitest';
import { createDraftId, parseDraftId, generateRequestId, escapeFanoutKey, canonicalizePath, disambiguateFanoutKeys } from '../../packages/core/src/intake/draft-id.js';

describe('draft-id', () => {
  describe('createDraftId / parseDraftId', () => {
    it('roundtrips correctly', () => {
      const id = createDraftId('req-123', 5, 'root');
      expect(id).toBe('req-123:5:root');
      const parsed = parseDraftId(id);
      expect(parsed?.requestId).toBe('req-123');
      expect(parsed?.taskIndex).toBe(5);
      expect(parsed?.nodeId).toBe('root');
    });

    it('defaults nodeId to root', () => {
      const id = createDraftId('req-1', 0);
      expect(id).toBe('req-1:0:root');
    });

    it('returns null for malformed draftId', () => {
      expect(parseDraftId('not-valid')).toBeNull();
      expect(parseDraftId('a:b')).toBeNull();
      expect(parseDraftId('a:b:c:d')).toBeNull();
    });

    it('returns null for non-numeric taskIndex', () => {
      expect(parseDraftId('req:x:node')).toBeNull();
    });
  });

  describe('generateRequestId', () => {
    it('returns a valid UUID', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('returns unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('escapeFanoutKey', () => {
    it('percent-encodes colons', () => {
      expect(escapeFanoutKey('path/to:file')).toBe('path%2Fto%3Afile');
    });

    it('percent-encodes pipes', () => {
      expect(escapeFanoutKey('a|b')).toBe('a%7Cb');
    });

    it('encodes slashes too', () => {
      expect(escapeFanoutKey('src/foo.ts')).toBe('src%2Ffoo.ts');
    });

    it('leaves simple names unchanged', () => {
      expect(escapeFanoutKey('root')).toBe('root');
    });
  });

  describe('canonicalizePath', () => {
    it('converts backslashes to forward slashes', () => {
      expect(canonicalizePath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
    });

    it('strips leading ./', () => {
      expect(canonicalizePath('./src/foo.ts')).toBe('src/foo.ts');
    });

    it('leaves simple paths unchanged', () => {
      expect(canonicalizePath('src/foo.ts')).toBe('src/foo.ts');
    });
  });

  describe('disambiguateFanoutKeys', () => {
    it('returns empty map when all nodeIds are unique', () => {
      const ids = [
        createDraftId('req', 0, 'root'),
        createDraftId('req', 1, 'leaf'),
        createDraftId('req', 2, 'src%2Ffoo.ts'),
      ];
      const result = disambiguateFanoutKeys(ids);
      expect(result.size).toBe(0);
    });

    it('returns entries for duplicate nodeIds', () => {
      const ids = [
        createDraftId('req', 0, 'root'),
        createDraftId('req', 1, 'root'),
        createDraftId('req', 2, 'src%2Ffoo.ts'),
      ];
      const result = disambiguateFanoutKeys(ids);
      expect(result.has('root')).toBe(true);
      expect(result.get('root')).toEqual([ids[0], ids[1]]);
    });
  });
});