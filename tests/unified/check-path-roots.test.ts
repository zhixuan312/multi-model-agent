import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCEPTED_CHECK_ROOTS,
  assertSafeAcceptanceTestPaths,
  ContractPlanError,
  type ContractPlanSnapshot,
} from '@zhixuan92/multi-model-agent-core';

/**
 * A declared check must be confined, but NOT to a JavaScript directory name.
 *
 * Reported from real use: `execute_plan` rejected a plan because it "requires tests under a
 * repo-root `tests/`". The caller abandoned `execute_plan` for `delegate` to get the work done.
 * The rule was a single hardcoded `tests/` — a JavaScript convention embedded in a grammar this
 * release made deliverable-neutral. Python commonly uses `test/`, Java uses `src/test/java`, and
 * for a finance report whose check reconciles figures against a source ledger, a directory called
 * "tests" is simply the wrong word.
 *
 * Widening the permitted roots must not weaken confinement. The properties that actually keep
 * materialisation safe never depended on the directory's NAME, and every one of them is asserted
 * below: relative only, no traversal, inside a permitted root, and no symlink crossing. The
 * never-overwrite rule lives in `materializeAcceptanceTests` and is covered by its own tests.
 */

// A COMPLETE `ContractPlanSnapshot`, not a partial one cast past the compiler. This fixture used
// to end `} as never`, which silenced the three required fields it omits (`output`, `dependencies`,
// `contract`) — so the file compiled while describing a snapshot the parser can never produce, and
// the typecheck could not notice if the shape moved underneath it.
const snapshot = (path: string): ContractPlanSnapshot => ({
  tasks: [{
    id: 'I-1',
    title: 'Task I-1: check path',
    output: 'out/x',
    dependencies: 'none',
    contract: {
      inputsRequest: 'x',
      outputsResponse: 'y',
      dataMapping: 'z',
      errors: 'e',
      behaviorInvariants: 'b',
    },
    acceptanceTests: [{ path, source: '// check', command: 'node --test' }],
  }],
});

describe('accepted check roots', () => {
  it('accepts a check under every documented root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-roots-'));
    try {
      for (const root of ACCEPTED_CHECK_ROOTS) {
        await expect(
          assertSafeAcceptanceTestPaths(snapshot(`${root}/verify.test.mjs`), repo),
        ).resolves.toBeUndefined();
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('accepts a nested path under a permitted root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-nested-'));
    try {
      await expect(
        assertSafeAcceptanceTestPaths(snapshot('checks/figures/tie-to-ledger.mjs'), repo),
      ).resolves.toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('accepts the Java layout its own documentation cites', async () => {
    // Second-review finding: the doc comment justified the widening by citing Java's
    // `src/test/java`, but the root list held only top-level names, so that exact path was still
    // rejected. A caller following the code's own stated guidance would still have been forced
    // back to `delegate` — the workaround the change existed to remove.
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-java-'));
    try {
      await expect(assertSafeAcceptanceTestPaths(snapshot('src/test/java/FooTest.java'), repo))
        .resolves.toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('names every permitted root when it rejects, so the author can fix it immediately', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-reject-'));
    try {
      await expect(assertSafeAcceptanceTestPaths(snapshot('src/verify.test.mjs'), repo))
        .rejects.toThrow(/must sit under one of: tests, test, spec, specs, checks, __tests__/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('confinement is unchanged by the widening', () => {
  it('still rejects an absolute path', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-abs-'));
    try {
      await expect(assertSafeAcceptanceTestPaths(snapshot('/etc/passwd'), repo))
        .rejects.toBeInstanceOf(ContractPlanError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('still rejects a traversal segment, even from inside a permitted root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-trav-'));
    try {
      await expect(assertSafeAcceptanceTestPaths(snapshot('tests/../../escape.mjs'), repo))
        .rejects.toThrow(/traversal/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('still rejects a path outside every permitted root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-outside-'));
    try {
      // `testsuite` starts with the letters of `tests` — a prefix comparison without a separator
      // would wrongly accept it, so this pins the separator check.
      await expect(assertSafeAcceptanceTestPaths(snapshot('testsuite/verify.mjs'), repo))
        .rejects.toThrow(/must sit under one of/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('still catches a symlinked root when the repository root carries a trailing separator', async () => {
    // Fourth-review finding, created by round 3's fix. That fix derived the relative path with
    // `absTargetPath.slice(repositoryRoot.length + 1)`. For a root written as `/repo/` the slice
    // eats the first character, the walk starts at a segment that does not exist, breaks on its
    // first iteration, and NO symlink check runs — the guard silently disables itself based on how
    // the caller spelled its path. `path.relative` is correct for every spelling.
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-trailing-'));
    const outside = await mkdtemp(join(tmpdir(), 'mma-check-trailing-target-'));
    try {
      await symlink(outside, join(repo, 'tests'), 'dir');
      await expect(assertSafeAcceptanceTestPaths(snapshot('tests/verify.mjs'), repo + '/'))
        .rejects.toThrow(/symlinked ancestor/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a check whose INTERMEDIATE ancestor is a symlink', async () => {
    // Third-review finding, introduced by accepting the NESTED root `src/test`. The guard used to
    // start its walk AT the matched root, so `lstat(<repo>/src/test)` silently FOLLOWED a symlinked
    // `src` and then reported only on `test`. The check file would have been written outside the
    // repository, by a direct server-side write with no sandbox in front of it.
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-midlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'mma-check-midlink-target-'));
    try {
      await mkdir(join(outside, 'test'), { recursive: true });
      // `src` itself is the symlink; `src/test` beyond it is an ordinary directory.
      await symlink(outside, join(repo, 'src'), 'dir');
      await expect(assertSafeAcceptanceTestPaths(snapshot('src/test/java/FooTest.java'), repo))
        .rejects.toThrow(/symlinked ancestor/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('still refuses a check whose root is a symlink escaping the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mma-check-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'mma-check-outside-real-'));
    try {
      await mkdir(join(outside, 'landing'), { recursive: true });
      await writeFile(join(outside, 'landing', 'marker.txt'), 'outside');
      // `checks` itself is a symlink pointing out of the repository.
      await symlink(join(outside, 'landing'), join(repo, 'checks'), 'dir');
      await expect(assertSafeAcceptanceTestPaths(snapshot('checks/verify.mjs'), repo))
        .rejects.toBeInstanceOf(ContractPlanError);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
