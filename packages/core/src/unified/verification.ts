import { canonicalDigest, compareByCodePoint } from './canonical-json.js';
import type { CommandCheck, ResolvedReference, VerificationMethod } from './deliverable-contract.js';

/**
 * The verification evidence model: WHAT was checked, HOW, and with what result.
 *
 * Two digests are required to make completion truthful, and they answer different questions.
 * `contractDigest` proves the definition of "good" did not change. `subjectDigest` proves the
 * checked OUTPUT did not change. Without the subject, a file edited after its command passed
 * would keep stale passing evidence while the contract digest still matched — completion would
 * be reported against work that no longer exists in that form.
 *
 * The caller owns this file (`.mma/verifications/<stem>.json`); the engine never writes it. What
 * the engine owns is the SHAPE and the DIGEST ALGORITHM, shipped here so that this package and
 * Forge compute identical values for identical output. Closure depends on that agreement: if the
 * two components digested subjects differently, evidence written by one would read as stale to
 * the other, and a finished flow would wait forever for verification it already has.
 */

/**
 * WHAT was checked.
 *
 * The file variant carries `root` for the same reason `DeclaredArtifact` does: two artifacts may
 * share one relative path under different roots, and without `root` the evidence could not tell
 * them apart — content swapped between them would keep the same recorded digest.
 */
export type VerificationSubject =
  | { type: 'git'; repositories: Array<{ repositoryId: string; commit: string }> }
  | { type: 'files'; artifacts: Array<{ root: string; path: string; digest: string }> };

/**
 * Evidence is method-specific.
 *
 * `passed | failed | not-run` plus free text is too weak for durable audit evidence.
 * "The executable was not found" is a different fact from "the claim is false": both block
 * completion, but only the second one says anything about the deliverable. A reader deciding what
 * to do next needs them separated.
 */
export type VerificationOutcome =
  | { status: 'passed' | 'failed'; method: 'command'; exitCode: number; outputDigest: string }
  | { status: 'error'; method: 'command'; errorKind: 'not-found' | 'timeout' | 'spawn-failure'; detail: string }
  | { status: 'passed' | 'failed'; method: 'agent-review'; reviewer: string; rationale: string; citedEvidence: string[] }
  | { status: 'approved' | 'rejected'; method: 'human'; decidedBy: string; note?: string }
  | { status: 'not-run'; method: VerificationMethod };

export interface VerificationRecord {
  /** The acceptance criterion this record is evidence for. */
  id: string;
  /** Digest of the `VerificationSubject` this record is bound to. Stale evidence is not evidence. */
  subjectDigest: string;
  /** What was actually observed, and when — as opposed to what the contract DECLARED. */
  resolvedReferences: ResolvedReference[];
  command?: CommandCheck;
  outcome: VerificationOutcome;
  observedAt: string;
}

export interface VerificationFile {
  schemaVersion: 1;
  stem: string;
  /** The APPROVED contract digest these records were produced against. */
  contractDigest: string;
  subject: VerificationSubject;
  records: Record<string, VerificationRecord>;
}

/**
 * `subjectDigest` — a named algorithm, not an idea.
 *
 * 1. Sort `repositories` by `repositoryId`, or `artifacts` by `root` then `path` — the same
 *    two-key order the contract's own `DeclaredArtifact[]` uses — ascending by UTF-8 code point.
 * 2. Recursively sort object keys the same way; normalise strings to NFC.
 * 3. Encode as UTF-8 JSON with no insignificant whitespace; digest with SHA-256.
 *
 * Sorting happens HERE rather than in the shared canonicaliser because array order is semantic
 * elsewhere (acceptance criteria run in declared order). The order of repositories and artifacts
 * is not semantic, so normalising it means two callers listing the same outputs in different
 * order still agree.
 *
 * The `path` is used verbatim, NOT normalised. A subject records what was actually checked; two
 * different declared spellings of one path are different observations, and quietly collapsing
 * them would assert an equivalence this function cannot verify without a filesystem.
 */
export function canonicalSubjectDigest(subject: VerificationSubject): string {
  if (subject.type === 'git') {
    const repositories = [...subject.repositories]
      .map((entry) => ({ repositoryId: entry.repositoryId, commit: entry.commit }))
      // Total order, not merely a grouping. Without the final tie-breaker, two entries sharing a
      // repositoryId compare equal, a stable sort preserves the CALLER's order, and two callers
      // listing the same subject differently would digest it differently.
      .sort((a, b) => compareByCodePoint(a.repositoryId, b.repositoryId) || compareByCodePoint(a.commit, b.commit));
    return canonicalDigest({ type: 'git', repositories });
  }
  const artifacts = [...subject.artifacts]
    .map((entry) => ({ root: entry.root, path: entry.path, digest: entry.digest }))
    // Total order: `digest` is the final tie-breaker, so two entries with the same (root, path)
    // but different content still sort deterministically instead of keeping input order.
    .sort((a, b) => compareByCodePoint(a.root, b.root) || compareByCodePoint(a.path, b.path)
      || compareByCodePoint(a.digest, b.digest));
  return canonicalDigest({ type: 'files', artifacts });
}

/**
 * Is this record usable evidence for `criterion` against the CURRENT output?
 *
 * Four independent reasons a record proves nothing, each of which has to be checked separately
 * because each fails differently:
 *  - no record at all;
 *  - the record is bound to a different (older) subject — the output moved on;
 *  - the record was produced by a different method than the criterion declares;
 *  - the outcome is not a pass.
 *
 * `failed` and `error` both fail closure, and `not-run` fails for every method. A `human`
 * criterion passes only on `approved`; `rejected` is a decision, not an absence, and the caller
 * must terminate rather than wait.
 */
export function isClosingRecord(
  record: VerificationRecord | undefined,
  criterion: { id: string; method: VerificationMethod },
  currentSubjectDigest: string,
): boolean {
  if (!record) return false;
  // The record is looked up BY criterion id, but its own `id` is authored by the caller — this
  // file is written by Forge or by an agent following the mma-flow skill, and the engine never
  // writes it. A copy-paste that files AC-2's evidence under the key "AC-1" would otherwise close
  // AC-1 using a result that was never about AC-1. Nothing else validates this, so check it here.
  if (record.id !== criterion.id) return false;
  if (record.subjectDigest !== currentSubjectDigest) return false;
  if (record.outcome.method !== criterion.method) return false;
  switch (criterion.method) {
    case 'command':
    case 'agent-review':
      return record.outcome.status === 'passed';
    case 'human':
      return record.outcome.status === 'approved';
    default:
      return false;
  }
}

/** Does every declared criterion have closing evidence against the current output?
 *  This is the gate `done` depends on — delivery alone is never sufficient. */
export function acceptanceClosed(
  acceptance: Array<{ id: string; method: VerificationMethod }>,
  records: Record<string, VerificationRecord>,
  currentSubjectDigest: string,
): boolean {
  return acceptance.every((criterion) => isClosingRecord(records[criterion.id], criterion, currentSubjectDigest));
}
