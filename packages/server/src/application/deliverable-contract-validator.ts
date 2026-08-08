// Deliverable Contract boundary validator — the filesystem-aware half of contract
// validation that `packages/core/src/unified/deliverable-contract.ts` deliberately does
// NOT do. Core validates shape and the lifecycle-free digest with no disk access; this
// module checks the parts that need the live filesystem and the task's `cwd`:
//
//  - INV-1: realpath containment of every declared artifact root (and the path under it).
//  - The same realpath-ancestor containment for `CommandCheck.cwd`.
//  - INV-3: disposition feasibility (`pr` / `commit-in-place` require a git repository;
//    `deliver-file` does not).
//
// Both transports (REST `handlers/unified-task.ts`, MCP `mcp-adapter.ts`) call
// `validateDeliverableContractBoundary` with the SAME already-validated Zod contract (core
// already enforced INV-7's digest match) and the same canonical `cwd`, so a caller sees
// identical field-specific errors regardless of transport. Runs BEFORE `ExecutionRuntime.submit`
// — a boundary rejection never opens a provider session.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { approvedContractSchema, type ApprovedContract } from '@zhixuan92/multi-model-agent-core';

export type DeliverableBoundaryFieldErrors = { formErrors: string[]; fieldErrors: Record<string, string[]> };

export type DeliverableBoundaryResult =
  | { ok: true }
  | { ok: false; fieldErrors: DeliverableBoundaryFieldErrors };

/** lowercase-kebab slug: lowercase, runs of non `[a-z0-9]` collapse to one hyphen, leading/
 *  trailing hyphens stripped. Matches the slug rule INV-1 defines for artifact roots. */
function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** True when `candidateReal` is `boundaryReal` itself or nested under it. Both arguments
 *  must already be realpath-resolved. */
function isWithin(candidateReal: string, boundaryReal: string): boolean {
  const boundaryWithSep = boundaryReal.endsWith(path.sep) ? boundaryReal : boundaryReal + path.sep;
  return candidateReal === boundaryReal || candidateReal.startsWith(boundaryWithSep);
}

/**
 * Realpath of the nearest existing ancestor of `absPath`, with the non-existent suffix
 * (an artifact or command path names an output that may not exist yet) re-appended
 * lexically. Non-existent segments cannot be symlinks, so re-appending them after
 * resolving the existing prefix is sound: it reproduces the path `absPath` would resolve
 * to once every segment exists, without requiring that they do.
 */
function nearestExistingAncestorReal(absPath: string): string {
  let current = absPath;
  const removedSegments: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return removedSegments.length === 0 ? real : path.join(real, ...removedSegments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absPath; // exhausted the path (the filesystem root always exists in practice)
      removedSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/** Realpath containment check for a path that may not exist yet: resolve the nearest
 *  existing ancestor and confirm the reconstructed candidate stays within `boundaryReal`
 *  (an already realpath-resolved directory). */
function escapesBoundary(candidateAbs: string, boundaryReal: string): boolean {
  return !isWithin(nearestExistingAncestorReal(candidateAbs), boundaryReal);
}

type RootResolution = { ok: true; dir: string } | { ok: false; message: string };

/**
 * Resolve a declared artifact `root` to an absolute directory.
 *
 * `'workspaceRoot'` resolves to the workspace root itself. Any other value names an
 * immediate child directory of the workspace root whose name normalises (via `slugify`) to
 * the same slug as `root`. Zero matches and more than one match (a slug collision) are both
 * rejected — ambiguity is never guessed.
 */
function resolveArtifactRoot(root: string, workspaceRoot: string): RootResolution {
  if (root === 'workspaceRoot') return { ok: true, dir: workspaceRoot };

  const wanted = slugify(root);
  let entries: string[];
  try {
    entries = fs.readdirSync(workspaceRoot);
  } catch {
    return { ok: false, message: `artifact root '${root}' could not be resolved: the workspace root is not readable` };
  }

  const childDirNames = entries.filter((name) => {
    try {
      return fs.statSync(path.join(workspaceRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  const matches = childDirNames.filter((name) => slugify(name) === wanted);

  if (matches.length === 0) {
    return { ok: false, message: `artifact root '${root}' does not name an immediate child directory of the workspace root` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `artifact root '${root}' is ambiguous: immediate child directories ${matches.map((m) => `'${m}'`).join(', ')} all normalise to the same slug`,
    };
  }
  return { ok: true, dir: path.join(workspaceRoot, matches[0]!) };
}

/** A `.git` entry check — a directory in a normal checkout, a file in a linked worktree.
 *  Both count: a caller may legitimately hand us its own worktree as the workspace root. */
function isGitRepo(workspaceRoot: string): boolean {
  return fs.existsSync(path.join(workspaceRoot, '.git'));
}

function checkArtifactRootAndPath(
  artifact: { root: string; path: string },
  index: number,
  workspaceRoot: string,
  workspaceRootReal: string,
  ctx: z.RefinementCtx,
): void {
  const resolved = resolveArtifactRoot(artifact.root, workspaceRoot);
  if (!resolved.ok) {
    ctx.addIssue({ code: 'custom', path: ['deliverable', 'artifacts', index, 'root'], message: resolved.message });
    return;
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(resolved.dir);
  } catch {
    ctx.addIssue({
      code: 'custom',
      path: ['deliverable', 'artifacts', index, 'root'],
      message: `artifact root '${artifact.root}' resolved to a directory that could not be read`,
    });
    return;
  }

  // The resolved root directory itself must stay inside the workspace root — an
  // immediate child directory that is actually a symlink escaping the workspace is
  // rejected here, before its declared artifacts are even considered.
  if (artifact.root !== 'workspaceRoot' && !isWithin(rootReal, workspaceRootReal)) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliverable', 'artifacts', index, 'root'],
      message: `artifact root '${artifact.root}' escapes the workspace root`,
    });
    return;
  }

  const candidateAbs = path.join(resolved.dir, artifact.path);
  if (escapesBoundary(candidateAbs, rootReal)) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliverable', 'artifacts', index, 'path'],
      message: `artifact path escapes its declared root: root '${artifact.root}' path '${artifact.path}'`,
    });
  }
}

function checkCommandCwd(
  command: { cwd?: string },
  issuePath: (string | number)[],
  workspaceRoot: string,
  workspaceRootReal: string,
  ctx: z.RefinementCtx,
): void {
  if (command.cwd === undefined) return;
  const candidateAbs = path.join(workspaceRoot, command.cwd);
  if (escapesBoundary(candidateAbs, workspaceRootReal)) {
    ctx.addIssue({
      code: 'custom',
      path: issuePath,
      message: `command cwd escapes the workspace root: '${command.cwd}'`,
    });
  }
}

function checkDispositionFeasibility(
  contract: ApprovedContract,
  workspaceRoot: string,
  ctx: z.RefinementCtx,
): void {
  if (contract.disposition === 'deliver-file') return; // permitted either way
  if (!isGitRepo(workspaceRoot)) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliverable', 'disposition'],
      message: `disposition '${contract.disposition}' requires the workspace root to be a git repository`,
    });
  }
}

/**
 * Validate the filesystem-dependent invariants of an already-Zod-valid `deliverable`
 * against the task's canonical `workspaceRoot`. `deliverable` absent is always valid
 * (unmanaged direct calls); every non-`undefined` `deliverable` reaching this function has
 * already passed `approvedContractSchema` (state `approved`, digest-matched approval).
 *
 * Returns the SAME `{ formErrors, fieldErrors }` shape `ZodError.flatten()` produces
 * elsewhere at this boundary, so REST and MCP report identical field-specific details.
 */
export function validateDeliverableContractBoundary(
  deliverable: ApprovedContract | undefined,
  workspaceRoot: string,
): DeliverableBoundaryResult {
  if (deliverable === undefined) return { ok: true };

  let workspaceRootReal: string;
  try {
    workspaceRootReal = fs.realpathSync(workspaceRoot);
  } catch {
    return {
      ok: false,
      fieldErrors: { formErrors: [], fieldErrors: { deliverable: ['workspace root could not be resolved'] } },
    };
  }

  const boundarySchema = z.object({ deliverable: approvedContractSchema }).superRefine((value, ctx) => {
    value.deliverable.artifacts.forEach((artifact, index) => {
      checkArtifactRootAndPath(artifact, index, workspaceRoot, workspaceRootReal, ctx);
    });
    value.deliverable.acceptance.forEach((criterion, index) => {
      if (criterion.command === undefined) return;
      checkCommandCwd(
        criterion.command,
        ['deliverable', 'acceptance', index, 'command', 'cwd'],
        workspaceRoot,
        workspaceRootReal,
        ctx,
      );
    });
    checkDispositionFeasibility(value.deliverable, workspaceRoot, ctx);
  });

  const result = boundarySchema.safeParse({ deliverable });
  if (result.success) return { ok: true };
  return { ok: false, fieldErrors: result.error.flatten() };
}
