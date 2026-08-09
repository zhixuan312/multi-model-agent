import { createHash } from 'node:crypto';

/**
 * The one canonical-JSON serialisation used by every digest this package defines.
 *
 * Two digests depend on it — `canonicalContractDigest` (what "good" means) and
 * `canonicalSubjectDigest` (what was actually checked) — and both must be computed identically
 * by this package AND by Forge, or evidence written by one component silently fails to validate
 * in the other. Sharing one implementation is what makes that guarantee real: a second
 * hand-maintained copy could only ever agree with itself, which is the failure mode a test
 * cannot catch because both copies pass their own tests.
 *
 * Deliberately filesystem-free and side-effect-free. Anything needing real paths, symlink
 * resolution or git state belongs at the server boundary, not here.
 */

/**
 * Compare by Unicode code point. UTF-8's byte order matches code point order, so comparing code
 * points is sufficient and avoids depending on the host's locale-sensitive default collation —
 * `String.prototype.localeCompare` would make the digest environment-dependent.
 */
export function compareByCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i]!.codePointAt(0) ?? 0) - (right[i]!.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * Recursively sort object keys by code point and normalise every string to NFC.
 *
 * ARRAY ORDER IS PRESERVED. Array order is frequently semantic — acceptance criteria run in
 * declared order — so a caller that needs a non-semantic array sorted must sort it BEFORE
 * calling this function, exactly as the contract digest sorts `artifacts` and the subject digest
 * sorts `repositories` and `artifacts`.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Keep each ORIGINAL key beside its normalised form. Sorting and emitting use the normalised
    // key; READING the value must use the original one.
    //
    // Reading through the normalised key is a silent hash collision, and it was a real defect
    // here. For a key that is not already NFC — `'e' + U+0301`, which is exactly what macOS
    // filenames produce — the normalised lookup misses, the value comes back `undefined`, and
    // `JSON.stringify` drops the property entirely. `{'é': 1}` then digested identically to `{}`,
    // and to `{'é': 999}`. Two different documents, one digest, no error.
    const pairs = Object.keys(source).map((original) => ({ original, normalized: original.normalize('NFC') }));
    pairs.sort((a, b) => compareByCodePoint(a.normalized, b.normalized));

    // Two distinct original keys can normalise to the same string. Picking either one silently is
    // a quieter form of the same bug — the digest would depend on key insertion order — so this
    // refuses rather than guesses. A caller hitting it has genuinely ambiguous data.
    for (let i = 1; i < pairs.length; i += 1) {
      if (pairs[i]!.normalized === pairs[i - 1]!.normalized) {
        throw new Error(
          `canonical JSON: keys ${JSON.stringify(pairs[i - 1]!.original)} and ${JSON.stringify(pairs[i]!.original)} `
          + 'are distinct but identical after NFC normalisation, so no canonical order exists',
        );
      }
    }

    const canonical: Record<string, unknown> = {};
    for (const { original, normalized } of pairs) {
      canonical[normalized] = canonicalizeValue(source[original]);
    }
    return canonical;
  }
  return value;
}

/** Canonicalise, encode as UTF-8 JSON with no insignificant whitespace, and digest with SHA-256.
 *  The `sha256:` prefix names the algorithm in the stored value, so a future change is visible in
 *  the data rather than only in the code that produced it. */
export function canonicalDigest(content: unknown): string {
  const json = JSON.stringify(canonicalizeValue(content));
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}
