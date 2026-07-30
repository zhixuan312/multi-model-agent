import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  parseContractPlan,
  assertSafeAcceptanceTestPaths,
  ContractPlanError,
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

  // Task selection comes from the parsed Contract snapshot, not the legacy
  // matchTasks/parsePlanHeadings matcher (which never recognized roman-numeral
  // "### Task I-N:" headings): select by exact, case-sensitive title match, or
  // every parsed Contract Task when the selector is empty.
  let selectedTasks: ContractPlanSnapshot['tasks'];
  if (epPayload.tasks.length === 0) {
    selectedTasks = fullSnapshot.tasks;
  } else {
    const byTitle = new Map(fullSnapshot.tasks.map((t) => [t.title, t] as const));
    const missing = epPayload.tasks.filter((title) => !byTitle.has(title));
    const duplicated = epPayload.tasks.filter((title, index) => epPayload.tasks.indexOf(title) !== index);
    if (missing.length > 0 || duplicated.length > 0) {
      const invalid = [...new Set([...missing, ...duplicated])];
      throw new PreprocessFailure('no_match', `No Contract Task matches selector(s) one-to-one: ${invalid.join(', ')}`);
    }
    selectedTasks = epPayload.tasks.map((title) => byTitle.get(title)!);
  }
  const selectedSnapshot: ContractPlanSnapshot = Object.freeze({ tasks: Object.freeze(selectedTasks) });

  // Path-safety preflight against the original (pre-worktree) cwd. The pipeline
  // repeats this against effectiveCwd/the worktree once materialization can
  // actually happen there; both checks legitimately coexist.
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

  return {
    acceptanceTestSnapshot: selectedSnapshot,
    dispatchedTasks: selectedSnapshot.tasks.map((t) => t.title),
    copyToWorktree: [path.isAbsolute(planPath) ? path.relative(fs.realpathSync(cwd), fs.realpathSync(resolvedPlanPath)) : planPath],
    totalTasks: selectedSnapshot.tasks.length,
  };
};
