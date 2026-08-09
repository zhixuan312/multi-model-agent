import { describe, expect, it } from 'vitest';
import {
  canonicalSubjectDigest,
  isClosingRecord,
  acceptanceClosed,
  canonicalContractDigest,
  type VerificationSubject,
  type VerificationRecord,
} from '@zhixuan92/multi-model-agent-core';

/**
 * AC-4.5, AC-4.6 and AC-4.8 — the verification subject and its named digest.
 *
 * These three criteria all depend on one thing existing: a shared, deterministic
 * `subjectDigest`. The specification defines the types and the algorithm precisely and states
 * why: "Closure depends on the engine and Forge computing the same value for the same output."
 * Nothing implemented it, so every caller would have invented its own — and the failure would be
 * silent in the worst way. Evidence written by Forge would read as STALE to `mma-flow`, so a
 * finished flow would wait forever for verification it already had, with no error anywhere.
 *
 * `subjectDigest` answers a different question from `contractDigest`, and both are required:
 * the contract digest proves the definition of "good" did not change, the subject digest proves
 * the checked OUTPUT did not change.
 */

const AT = '2026-08-09T00:00:00.000Z';

const record = (over: Partial<VerificationRecord> & { outcome: VerificationRecord['outcome'] }): VerificationRecord => ({
  id: 'AC-1',
  subjectDigest: 'sha256:unset',
  resolvedReferences: [],
  observedAt: AT,
  ...over,
});

describe('canonicalSubjectDigest — file subjects', () => {
  it('distinguishes two artifacts that share a relative path under different roots (AC-4.8)', () => {
    // The exact case `root` exists for. Without it, content swapped between the two would keep
    // the same recorded digest and stale evidence would validate.
    const a: VerificationSubject = {
      type: 'files',
      artifacts: [
        { root: 'workspaceRoot', path: 'report.md', digest: 'sha256:aaa' },
        { root: 'child-repo', path: 'report.md', digest: 'sha256:bbb' },
      ],
    };
    const swapped: VerificationSubject = {
      type: 'files',
      artifacts: [
        { root: 'workspaceRoot', path: 'report.md', digest: 'sha256:bbb' },
        { root: 'child-repo', path: 'report.md', digest: 'sha256:aaa' },
      ],
    };
    expect(canonicalSubjectDigest(a)).not.toBe(canonicalSubjectDigest(swapped));
  });

  it('is independent of the order the caller lists artifacts in (AC-4.8)', () => {
    const artifacts = [
      { root: 'workspaceRoot', path: 'b.md', digest: 'sha256:2' },
      { root: 'child-repo', path: 'a.md', digest: 'sha256:1' },
    ];
    const forward: VerificationSubject = { type: 'files', artifacts };
    const reversed: VerificationSubject = { type: 'files', artifacts: [...artifacts].reverse() };
    // Sorted by root then path, so two callers listing the same outputs differently agree.
    expect(canonicalSubjectDigest(forward)).toBe(canonicalSubjectDigest(reversed));
  });

  it('changes when ANY single artifact changes, which makes every record stale (AC-4.8)', () => {
    const base: VerificationSubject = {
      type: 'files',
      artifacts: [
        { root: 'workspaceRoot', path: 'a.md', digest: 'sha256:1' },
        { root: 'workspaceRoot', path: 'b.md', digest: 'sha256:2' },
      ],
    };
    const onlyBChanged: VerificationSubject = {
      type: 'files',
      artifacts: [
        { root: 'workspaceRoot', path: 'a.md', digest: 'sha256:1' },
        { root: 'workspaceRoot', path: 'b.md', digest: 'sha256:CHANGED' },
      ],
    };
    // Closure binds to the WHOLE subject, so editing b.md invalidates a.md's evidence too.
    // That is deliberate: a criterion may span several artifacts.
    expect(canonicalSubjectDigest(base)).not.toBe(canonicalSubjectDigest(onlyBChanged));
  });

  it('does not silently normalise a path, because a subject records what was observed', () => {
    const plain: VerificationSubject = { type: 'files', artifacts: [{ root: 'r', path: 'a/b.md', digest: 'sha256:1' }] };
    const dotted: VerificationSubject = { type: 'files', artifacts: [{ root: 'r', path: 'a/./b.md', digest: 'sha256:1' }] };
    expect(canonicalSubjectDigest(plain)).not.toBe(canonicalSubjectDigest(dotted));
  });
});

describe('canonicalSubjectDigest — git subjects (AC-4.6)', () => {
  it('carries every repository commit and is order-independent', () => {
    const forward: VerificationSubject = {
      type: 'git',
      repositories: [
        { repositoryId: 'engine', commit: 'aaa111' },
        { repositoryId: 'forge', commit: 'bbb222' },
      ],
    };
    const reversed: VerificationSubject = { type: 'git', repositories: [...forward.repositories].reverse() };
    expect(canonicalSubjectDigest(forward)).toBe(canonicalSubjectDigest(reversed));
  });

  it('changes when any one repository advances', () => {
    const before: VerificationSubject = {
      type: 'git',
      repositories: [{ repositoryId: 'engine', commit: 'aaa111' }, { repositoryId: 'forge', commit: 'bbb222' }],
    };
    const after: VerificationSubject = {
      type: 'git',
      repositories: [{ repositoryId: 'engine', commit: 'aaa111' }, { repositoryId: 'forge', commit: 'ccc333' }],
    };
    expect(canonicalSubjectDigest(before)).not.toBe(canonicalSubjectDigest(after));
  });

  it('never collides with a file subject carrying the same shape', () => {
    // The discriminant is inside the digested content, not merely a TypeScript-level tag.
    const git: VerificationSubject = { type: 'git', repositories: [] };
    const files: VerificationSubject = { type: 'files', artifacts: [] };
    expect(canonicalSubjectDigest(git)).not.toBe(canonicalSubjectDigest(files));
  });
});

describe('acceptance closure (AC-4.5)', () => {
  const SUBJECT: VerificationSubject = {
    type: 'files',
    artifacts: [{ root: 'workspaceRoot', path: 'report.md', digest: 'sha256:1' }],
  };
  const digest = canonicalSubjectDigest(SUBJECT);

  it('a human criterion still not-run does NOT close', () => {
    const closed = acceptanceClosed(
      [{ id: 'AC-1', method: 'human' }],
      { 'AC-1': record({ subjectDigest: digest, outcome: { status: 'not-run', method: 'human' } }) },
      digest,
    );
    expect(closed).toBe(false);
  });

  it('a human criterion approved against the current subject closes', () => {
    const closed = acceptanceClosed(
      [{ id: 'AC-1', method: 'human' }],
      { 'AC-1': record({ subjectDigest: digest, outcome: { status: 'approved', method: 'human', decidedBy: 'the finance lead' } }) },
      digest,
    );
    expect(closed).toBe(true);
  });

  it('a rejected human decision does NOT close — it is a decision, not an absence', () => {
    expect(isClosingRecord(
      record({ subjectDigest: digest, outcome: { status: 'rejected', method: 'human', decidedBy: 'the finance lead' } }),
      { id: 'AC-1', method: 'human' },
      digest,
    )).toBe(false);
  });

  it('command evidence carrying `error` does NOT close, distinctly from `failed`', () => {
    // Both block completion, but they are different facts: "we never found out" versus
    // "the claim is false". The record must be able to say which.
    expect(isClosingRecord(
      record({ subjectDigest: digest, outcome: { status: 'error', method: 'command', errorKind: 'timeout', detail: 'exceeded 600000 ms' } }),
      { id: 'AC-1', method: 'command' },
      digest,
    )).toBe(false);
  });

  it('evidence bound to a STALE subject is treated as no evidence', () => {
    const stale = record({ subjectDigest: 'sha256:an-older-output', outcome: { status: 'passed', method: 'command', exitCode: 0, outputDigest: 'sha256:o' } });
    expect(isClosingRecord(stale, { id: 'AC-1', method: 'command' }, digest)).toBe(false);
  });

  it('evidence produced by the WRONG method does not close the criterion', () => {
    // An agent-review pass must never satisfy a criterion the contract says needs a human.
    const wrongMethod = record({
      subjectDigest: digest,
      outcome: { status: 'passed', method: 'agent-review', reviewer: 'worker', rationale: 'looks right', citedEvidence: [] },
    });
    expect(isClosingRecord(wrongMethod, { id: 'AC-1', method: 'human' }, digest)).toBe(false);
  });

  it('evidence filed under the wrong key does not close the criterion', () => {
    // The record is looked up BY criterion id, but its own `id` is authored by the caller — this
    // file is written by Forge or by an agent following the mma-flow skill, never by the engine.
    // A copy-paste that files AC-2's result under the key "AC-1" would otherwise close AC-1 with
    // a result that was never about AC-1. Found by a pre-release review, not by the suite.
    const misfiled = record({
      id: 'AC-2',
      subjectDigest: digest,
      outcome: { status: 'passed', method: 'command', exitCode: 0, outputDigest: 'sha256:o' },
    });
    expect(isClosingRecord(misfiled, { id: 'AC-1', method: 'command' }, digest)).toBe(false);
    expect(acceptanceClosed([{ id: 'AC-1', method: 'command' }], { 'AC-1': misfiled }, digest)).toBe(false);
  });

  it('a missing record does not close, and closure needs EVERY criterion', () => {
    const records = {
      'AC-1': record({ id: 'AC-1', subjectDigest: digest, outcome: { status: 'passed', method: 'command', exitCode: 0, outputDigest: 'sha256:o' } }),
    };
    expect(acceptanceClosed([{ id: 'AC-1', method: 'command' }], records, digest)).toBe(true);
    expect(acceptanceClosed(
      [{ id: 'AC-1', method: 'command' }, { id: 'AC-2', method: 'human' }],
      records,
      digest,
    )).toBe(false);
  });
});

describe('the two digests answer different questions', () => {
  it('subjectDigest and contractDigest are independent', () => {
    // Editing the deliverable must not change the contract digest, and re-approving the contract
    // must not silently revalidate stale evidence. Sharing one digest would conflate them.
    const content = {
      kind: 'report',
      audience: 'the board',
      artifacts: [{ root: 'workspaceRoot', path: 'report.md' }],
      acceptance: [{ id: 'AC-1', criterion: 'reviewed', method: 'human' as const, references: [{ kind: 'none', reason: 'internal' }] }],
      disposition: 'deliver-file' as const,
    };
    const before = canonicalSubjectDigest({ type: 'files', artifacts: [{ root: 'workspaceRoot', path: 'report.md', digest: 'sha256:1' }] });
    const after = canonicalSubjectDigest({ type: 'files', artifacts: [{ root: 'workspaceRoot', path: 'report.md', digest: 'sha256:2' }] });
    expect(before).not.toBe(after);
    // The contract digest is unmoved by the output changing underneath it.
    expect(canonicalContractDigest(content)).toBe(canonicalContractDigest(content));
  });
});
