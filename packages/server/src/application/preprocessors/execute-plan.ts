import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseContractPlan,
  assertSafeAcceptanceTestPaths,
  ContractPlanError,
  dispatchedTasksFromSnapshot,
  resolveSelectors,
  describeSelectorFailure,
  type ContractPlanSnapshot,
} from '@zhixuan92/multi-model-agent-core';
import { PreprocessFailure, type Preprocessor } from './types.js';

/**
 * Execute-plan pre-processing: parse + validate the frozen Contract Task plan
 * and select the dispatched tasks BEFORE any provider session opens. Any
 * structural, path-safety, or selector problem fails the task terminally here
 * (zero provider sessions) — the client learns of it by polling.
 */
export const executePlanPreprocessor: Preprocessor = async ({ cwd, payload }) => {
  const epPayload = payload as { target: { paths: string[] }; tasks: string[] };
  const planPath = epPayload.target.paths[0];
  const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.resolve(cwd, planPath);
  let planContent: string;
  try {
    planContent = fs.readFileSync(resolvedPlanPath, 'utf-8');
  } catch {
    throw new PreprocessFailure('plan_not_found', `Plan file not found: ${planPath}`);
  }

  let fullSnapshot: ContractPlanSnapshot;
  try {
    fullSnapshot = parseContractPlan(planContent);
  } catch (err) {
    if (err instanceof ContractPlanError) {
      throw new PreprocessFailure(err.code, err.message);
    }
    throw err;
  }

  // Selection resolves through the SAME task-id scheme the reviewer contract uses — one
  // identity for a task, everywhere. A selector may be the bare id ("I-1") or any spelling of
  // the heading it came from; resolveSelectors extracts the id either way, so a caller who
  // copied a heading and dropped its `(← AC-…)` annotation no longer gets a spurious no_match.
  // An empty selector list means every parsed Contract Task.
  let selectedTasks: ContractPlanSnapshot['tasks'];
  if (epPayload.tasks.length === 0) {
    selectedTasks = fullSnapshot.tasks;
  } else {
    const byId = new Map(fullSnapshot.tasks.map((t) => [t.id, t] as const));
    const resolution = resolveSelectors(epPayload.tasks, dispatchedTasksFromSnapshot(fullSnapshot));
    if (!resolution.ok) {
      throw new PreprocessFailure('no_match', describeSelectorFailure(resolution));
    }
    selectedTasks = resolution.ids.map((id) => byId.get(id)!);
  }
  const selectedSnapshot: ContractPlanSnapshot = Object.freeze({ tasks: Object.freeze(selectedTasks) });

  // Path-safety preflight, before any provider session opens: a plan declaring an acceptance-test
  // path that escapes the cwd fails here, having run nothing.
  //
  // The pipeline runs the SAME check again immediately before materializing (two-phase-pipeline
  // `assertSafeAcceptanceTestPaths` → `materializeAcceptanceTests`). Both coexist because they
  // happen at different TIMES, not against different directories: this one buys a terminal
  // failure with zero provider cost, and the pipeline's is adjacent to the write, so nothing can
  // change on disk between the check and the act.
  //
  // The comment here used to say the pipeline repeats it "against effectiveCwd/the worktree",
  // which described a second directory that has not existed since the engine stopped creating
  // worktrees — `effectiveCwd` is now literally `input.cwd`. Read as written, it implied the two
  // checks covered different paths, which is the one thing that would make dropping either safe.
  try {
    await assertSafeAcceptanceTestPaths(selectedSnapshot, cwd);
  } catch (err) {
    if (err instanceof ContractPlanError) {
      throw new PreprocessFailure(err.code, err.message);
    }
    throw err;
  }

  // Collision dry-run: refuse to dispatch when a declared acceptance-test path
  // already exists, without writing anything (materialization itself — and its
  // own collision check — only happens inside the pipeline).
  for (const task of selectedSnapshot.tasks) {
    for (const test of task.acceptanceTests) {
      const absTestPath = path.resolve(cwd, test.path);
      if (fs.existsSync(absTestPath)) {
        throw new PreprocessFailure('test-path-collision', `Acceptance test path "${test.path}" already exists; refusing to dispatch`);
      }
    }
  }

  const contractTasks = dispatchedTasksFromSnapshot(selectedSnapshot);

  return {
    acceptanceTestSnapshot: selectedSnapshot,
    // Prompt-facing labels lead with the stable id so the reviewer echoes it back.
    dispatchedTasks: contractTasks.map((t) => `${t.id}: ${t.title}`),
    // Authoritative matching key — never the prose title.
    dispatchedContractTasks: contractTasks,
    totalTasks: selectedSnapshot.tasks.length,
  };
};
