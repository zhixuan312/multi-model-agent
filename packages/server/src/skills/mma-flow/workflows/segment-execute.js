export function slugifySpecTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : 'task';
}

export function pickResumeStage(signals) {
  if (!signals.latestSpecPath) return 'D1';
  if (!signals.latestPlanPath) return 'B1';
  if (!signals.projectBranch) return 'B3';
  if (!signals.projectBranchHasUniqueCommits) return 'B5';
  if (!signals.currentSessionEvidence.reviewPassed) return 'B6';
  if (!signals.currentSessionEvidence.wholeRepoGreen) return 'B7';
  if (!signals.prExists) return 'B8';
  if (!signals.prMerged) return 'B9';
  return 'COMPLETE';
}

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

export async function runSegmentExecute(args, runtime = globalThis) {
  const runPhase = phaseRunner(runtime);
  return runPhase('execute-plan', () => runtime.agent({
    skill: 'mma-execute-plan',
    cwd: args.cwd,
    planPath: args.planPath,
    contextBlockIds: args.contextBlockIds ?? [],
  }));
}

export default async function main(args, runtime = globalThis) {
  return runSegmentExecute(args, runtime);
}
