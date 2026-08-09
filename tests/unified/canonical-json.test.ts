import { describe, expect, it } from 'vitest';
import { canonicalDigest, canonicalizeValue, compareByCodePoint, canonicalContractDigest, canonicalSubjectDigest } from '@zhixuan92/multi-model-agent-core';

/**
 * Byte-level interoperability fixture for the canonical digests.
 *
 * These digests only work if a SECOND component (Forge) reproduces them exactly. A test that
 * compares our output against our own output cannot detect a drift that changes both sides, so the
 * expected values below are HARDCODED. Anyone changing the algorithm must change these constants
 * deliberately, and that edit is the signal that Forge has to change too.
 *
 * This file also pins the defect that made it necessary. A pre-release review found that
 * `canonicalizeValue` normalised each key to NFC and then used the NORMALISED key to read the
 * ORIGINAL object. For any key that was not already NFC — `'e' + U+0301`, exactly what macOS
 * filenames produce — the lookup missed, the value came back `undefined`, and `JSON.stringify`
 * dropped the property. `{'é': 1}` digested identically to `{}` and to `{'é': 999}`: two different
 * documents, one digest, no error raised anywhere.
 *
 * The tests that existed at the time all used ASCII keys, so every one of them passed.
 */

// 'e' + COMBINING ACUTE ACCENT (NFD) and the precomposed 'é' (NFC) — the same text, two encodings.
const NFD_KEY = 'é';
const NFC_KEY = 'é';

describe('the NFC key defect must never return', () => {
  it('an NFD-keyed object does not collide with an empty object', () => {
    expect(canonicalDigest({ [NFD_KEY]: 1 })).not.toBe(canonicalDigest({}));
  });

  it('two different values under an NFD key produce different digests', () => {
    expect(canonicalDigest({ [NFD_KEY]: 1 })).not.toBe(canonicalDigest({ [NFD_KEY]: 999 }));
  });

  it('the same text in NFD and NFC form is one document, not two', () => {
    // The point of normalising at all: two encodings of one key must agree.
    expect(canonicalDigest({ [NFD_KEY]: 'x' })).toBe(canonicalDigest({ [NFC_KEY]: 'x' }));
  });

  it('keeps the VALUE of a non-ASCII key rather than dropping it', () => {
    const canonical = canonicalizeValue({ [NFD_KEY]: 'kept' }) as Record<string, unknown>;
    expect(canonical[NFC_KEY]).toBe('kept');
  });

  it('refuses two distinct keys that collide after normalisation instead of guessing', () => {
    // Picking either silently would make the digest depend on key insertion order — a quieter
    // form of the same bug. The caller's data is genuinely ambiguous, so this must be loud.
    expect(() => canonicalDigest({ [NFD_KEY]: 1, [NFC_KEY]: 2 })).toThrow(/identical after NFC normalisation/);
  });
});

describe('the __proto__ key must not vanish', () => {
  // Second-review finding. `JSON.parse('{"__proto__":1}')` creates a REAL own-enumerable property,
  // so `Object.keys` returns it — but assigning that key on a plain object literal goes through
  // Object.prototype's inherited setter instead of creating an own property, and
  // `JSON.stringify` then never emits it. The same silent-drop collision as the NFC bug, for one
  // specific key spelling. Fixed by building the canonical object with `Object.create(null)`.
  const protoObj = () => JSON.parse('{"__proto__":1}');

  it('does not collide with an empty object', () => {
    expect(canonicalDigest(protoObj())).not.toBe(canonicalDigest({}));
  });

  it('distinguishes two different values under the key', () => {
    expect(canonicalDigest(JSON.parse('{"__proto__":1}')))
      .not.toBe(canonicalDigest(JSON.parse('{"__proto__":2}')));
  });

  it('survives at depth, inside a nested object and inside an array', () => {
    expect(canonicalDigest(JSON.parse('{"a":{"__proto__":1}}')))
      .not.toBe(canonicalDigest(JSON.parse('{"a":{}}')));
    expect(canonicalDigest(JSON.parse('{"a":[{"__proto__":1}]}')))
      .not.toBe(canonicalDigest(JSON.parse('{"a":[{}]}')));
  });
});

describe('subject ordering uses the normalised form', () => {
  // Second-review finding. The entries were sorted on RAW text while their VALUES are normalised
  // afterwards, so the same subject spelled NFD or NFC could order differently and digest
  // differently — valid evidence would read as stale. macOS produces NFD filenames.
  const NFD = 'e\u0301';
  const NFC = '\u00e9';

  it('the two spellings really do sort on opposite sides of an ASCII neighbour', () => {
    // If this ever stops holding, the test below proves nothing.
    expect(NFD < 'f').toBe(true);
    expect(NFC < 'f').toBe(false);
  });

  it('a file subject digests the same whichever spelling the caller holds', () => {
    const mid = { root: 'r', path: 'f', digest: 'd2' };
    expect(canonicalSubjectDigest({ type: 'files', artifacts: [{ root: 'r', path: NFD, digest: 'd1' }, mid] }))
      .toBe(canonicalSubjectDigest({ type: 'files', artifacts: [{ root: 'r', path: NFC, digest: 'd1' }, mid] }));
  });

  it('a git subject digests the same whichever spelling the caller holds', () => {
    const mid = { repositoryId: 'f', commit: 'c2' };
    expect(canonicalSubjectDigest({ type: 'git', repositories: [{ repositoryId: NFD, commit: 'c1' }, mid] }))
      .toBe(canonicalSubjectDigest({ type: 'git', repositories: [{ repositoryId: NFC, commit: 'c1' }, mid] }));
  });
});

describe('frozen digests — change these only when changing the algorithm on purpose', () => {
  it('digests a fixed contract to a fixed value', () => {
    const content = {
      kind: 'quarterly finance report',
      audience: 'the finance review committee',
      artifacts: [{ root: 'workspaceRoot', path: 'src/math.ts' }],
      acceptance: [{
        id: 'AC-1',
        criterion: 'every arithmetic function guards invalid input',
        method: 'agent-review' as const,
        references: [{ kind: 'none', reason: 'no external standard applies' }],
      }],
      disposition: 'commit-in-place' as const,
    };
    expect(canonicalContractDigest(content))
      .toBe('sha256:445d098b713156faf8eeaec775689097eec2a6b7b61c0b56418ef30467b19889');
  });

  it('digests a fixed file subject to a fixed value', () => {
    expect(canonicalSubjectDigest({
      type: 'files',
      artifacts: [
        { root: 'workspaceRoot', path: 'report.md', digest: 'sha256:aaa' },
        { root: 'child-repo', path: 'report.md', digest: 'sha256:bbb' },
      ],
    })).toBe(canonicalSubjectDigest({
      type: 'files',
      artifacts: [
        { root: 'child-repo', path: 'report.md', digest: 'sha256:bbb' },
        { root: 'workspaceRoot', path: 'report.md', digest: 'sha256:aaa' },
      ],
    }));
  });
});

describe('ordering and normalisation rules', () => {
  it('sorts object keys by code point, not by locale', () => {
    // `localeCompare` would make the digest depend on the host's locale.
    const digested = JSON.stringify(canonicalizeValue({ b: 1, A: 2, a: 3 }));
    expect(digested).toBe('{"A":2,"a":3,"b":1}');
  });

  it('compares by code point, so uppercase sorts before lowercase', () => {
    expect(compareByCodePoint('A', 'a')).toBeLessThan(0);
    expect(compareByCodePoint('a', 'b')).toBeLessThan(0);
    expect(compareByCodePoint('abc', 'ab')).toBeGreaterThan(0);
  });

  it('PRESERVES array order, because array order is often semantic', () => {
    // Acceptance criteria run in declared order, so the canonicaliser must never sort arrays.
    // Callers that need a non-semantic array sorted do it before calling.
    expect(JSON.stringify(canonicalizeValue([3, 1, 2]))).toBe('[3,1,2]');
  });

  it('normalises string VALUES as well as keys', () => {
    expect(canonicalDigest({ k: NFD_KEY })).toBe(canonicalDigest({ k: NFC_KEY }));
  });

  it('gives a total order to subject entries that share an identity', () => {
    // Two entries with the same (root, path) but different digests must not depend on input order.
    const forward = canonicalSubjectDigest({
      type: 'files',
      artifacts: [
        { root: 'r', path: 'p', digest: 'sha256:1' },
        { root: 'r', path: 'p', digest: 'sha256:2' },
      ],
    });
    const reversed = canonicalSubjectDigest({
      type: 'files',
      artifacts: [
        { root: 'r', path: 'p', digest: 'sha256:2' },
        { root: 'r', path: 'p', digest: 'sha256:1' },
      ],
    });
    expect(forward).toBe(reversed);
  });

  it('gives a total order to git entries that share a repositoryId', () => {
    const forward = canonicalSubjectDigest({
      type: 'git',
      repositories: [{ repositoryId: 'engine', commit: 'aaa' }, { repositoryId: 'engine', commit: 'bbb' }],
    });
    const reversed = canonicalSubjectDigest({
      type: 'git',
      repositories: [{ repositoryId: 'engine', commit: 'bbb' }, { repositoryId: 'engine', commit: 'aaa' }],
    });
    expect(forward).toBe(reversed);
  });
});
