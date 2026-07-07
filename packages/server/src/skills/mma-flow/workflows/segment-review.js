const DEFAULT_CAP = 3;

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

function logger(runtime) {
  return typeof runtime.log === 'function' ? runtime.log.bind(runtime) : () => undefined;
}

function severityCounts(result) {
  const counts = result?.counts ?? {};
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    medium: Number(counts.medium ?? 0),
    low: Number(counts.low ?? 0),
  };
}

function normalizeCap(cap) {
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP;
}

export function buildCompareRange(sourceBranch) {
  return `${sourceBranch}...HEAD`;
}

function makeRound(round, reviewResult, fixedByAgent) {
  const counts = severityCounts(reviewResult);
  return {
    round,
    findingsSummary: String(reviewResult?.findingsSummary ?? ''),
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    fixedByAgent,
    contextBlockId: reviewResult?.contextBlockId ?? null,
  };
}

function isClean(round) {
  return round.criticalCount === 0 && round.highCount === 0;
}

export async function runSegmentReview(args, runtime = globalThis) {
  const cap = normalizeCap(args.cap);
  const rounds = [];
  let latestContextBlockId = args.contextBlockId ?? null;
  const runPhase = phaseRunner(runtime);
  const log = logger(runtime);

  for (let roundNumber = 1; roundNumber <= cap; roundNumber += 1) {
    const reviewResult = await runPhase(`code-review-${roundNumber}`, () => runtime.agent({
      skill: 'mma-review',
      cwd: args.cwd,
      compareRange: buildCompareRange(args.sourceBranch),
      contextBlockId: latestContextBlockId,
    }));

    latestContextBlockId = reviewResult?.contextBlockId ?? latestContextBlockId;
    const round = makeRound(roundNumber, reviewResult, false);
    rounds.push(round);

    if (isClean(round)) {
      log(`Code review cleared in round ${roundNumber}.`);
      return {
        cwd: args.cwd,
        sourceBranch: args.sourceBranch,
        roundsRun: roundNumber,
        clean: true,
        rounds,
        openFindings: [],
        blockingRemaining: false,
        proceed: true,
        note: `Code review cleared in round ${roundNumber}.`,
        contextBlockId: latestContextBlockId,
      };
    }

    if (args.autofix !== false && roundNumber < cap) {
      await runPhase(`code-review-fix-${roundNumber}`, () => runtime.agent({
        skill: 'mma-delegate',
        cwd: args.cwd,
        prompt: `Resolve the critical/high code review findings for the diff ${buildCompareRange(args.sourceBranch)}.`,
        contextBlockIds: latestContextBlockId ? [latestContextBlockId] : [],
      }));
      rounds[rounds.length - 1] = { ...round, fixedByAgent: true };
      continue;
    }
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    cwd: args.cwd,
    sourceBranch: args.sourceBranch,
    roundsRun: rounds.length,
    clean: false,
    rounds,
    openFindings: finalRound ? [finalRound.findingsSummary].filter(Boolean) : [],
    blockingRemaining: true,
    proceed: false,
    note: `Critical or high findings remain after round ${rounds.length}.`,
    contextBlockId: latestContextBlockId,
  };
}

export default async function main(args, runtime = globalThis) {
  return runSegmentReview(args, runtime);
}
