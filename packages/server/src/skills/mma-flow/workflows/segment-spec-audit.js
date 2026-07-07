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

function makeRound(round, auditResult, fixedByAgent) {
  const counts = severityCounts(auditResult);
  return {
    round,
    findingsSummary: String(auditResult?.findingsSummary ?? ''),
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    fixedByAgent,
    contextBlockId: auditResult?.contextBlockId ?? null,
  };
}

function isClean(round) {
  return round.criticalCount === 0 && round.highCount === 0;
}

export async function runSegmentSpecAudit(args, runtime = globalThis) {
  const cwd = args.cwd ?? process.cwd();
  const cap = normalizeCap(args.cap);
  const rounds = [];
  let latestContextBlockId = args.contextBlockId ?? null;
  const runPhase = phaseRunner(runtime);
  const log = logger(runtime);

  for (let roundNumber = 1; roundNumber <= cap; roundNumber += 1) {
    const auditResult = await runPhase(`spec-audit-${roundNumber}`, () => runtime.agent({
      skill: 'mma-audit',
      subtype: 'spec',
      cwd,
      targetPath: args.specPath,
      contextBlockId: latestContextBlockId,
    }));

    latestContextBlockId = auditResult?.contextBlockId ?? latestContextBlockId;
    const round = makeRound(roundNumber, auditResult, false);
    rounds.push(round);

    if (isClean(round)) {
      log(`Spec audit cleared in round ${roundNumber}.`);
      return {
        specPath: args.specPath,
        cwd,
        roundsRun: roundNumber,
        clean: true,
        rounds,
        openFindings: [],
        blockingRemaining: false,
        proceed: true,
        note: `Spec audit cleared in round ${roundNumber}.`,
        contextBlockId: latestContextBlockId,
      };
    }

    if (args.autofix !== false && roundNumber < cap) {
      await runPhase(`spec-audit-fix-${roundNumber}`, () => runtime.agent({
        skill: 'mma-delegate',
        cwd,
        prompt: `Resolve the critical/high spec audit findings for ${args.specPath}.`,
        contextBlockIds: latestContextBlockId ? [latestContextBlockId] : [],
      }));
      rounds[rounds.length - 1] = { ...round, fixedByAgent: true };
      continue;
    }
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    specPath: args.specPath,
    cwd,
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
  return runSegmentSpecAudit(args, runtime);
}
