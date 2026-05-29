//
// Sequences: turn-1 plan → Step-2 orchestrator. Returns plan+pack; the
// existing read-route-implementer N-criterion loop owns the synthesis side
// (see Task 13). This driver intentionally does NOT call session.send a
// second time itself.

import type { Session, TurnResult } from '../../types/run-result.js';
import { parseQueryPlan, type QueryPlan } from '../../research/query-plan.js';
import type { EvidencePack } from '../../research/evidence-pack.js';
import { compileTurn1PlanPrompt } from './brief-slot.js';

export interface TwoTurnDeps {
  session:           Pick<Session, 'send'>;
  runOrchestrator:   (plan: QueryPlan) => Promise<EvidencePack>;
  researchQuestion:  string;
  background?:       string;
}

// Returns turn-1 + EvidencePack. Synthesis turns are run BY THE EXISTING
// read-route-implementer N-criterion loop AFTER this driver completes —
// see Task 13 for the wiring. The driver intentionally does NOT call
// session.send a second time itself; the criterion loop owns that.
export interface TwoTurnResult {
  plan:           QueryPlan;
  pack:           EvidencePack;
  turn1Result:    TurnResult;
}

function tryParse(text: string): { ok: true; plan: QueryPlan } | { ok: false; err: string } {
  try {
    // Strip code fences if the worker emitted them despite instructions.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    return { ok: true, plan: parseQueryPlan(cleaned) };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

export async function runTwoTurnDriver(deps: TwoTurnDeps): Promise<TwoTurnResult> {
  // Turn 1.
  const turn1Prompt = compileTurn1PlanPrompt({
    researchQuestion: deps.researchQuestion,
    background:       deps.background,
  });
  // TurnResult.output is the worker text; no .text field exists.
  let turn1Result = await deps.session.send(turn1Prompt);
  let parsed = tryParse(turn1Result.output);

  if (!parsed.ok) {
    // Retry once with the schema error included.
    const retryPrompt = `Your previous output was not a valid QueryPlan: ${parsed.err}\n\n${turn1Prompt}`;
    turn1Result = await deps.session.send(retryPrompt);
    parsed = tryParse(turn1Result.output);
    if (!parsed.ok) {
      throw new Error(`research_plan_invalid: ${parsed.err}`);
    }
  }
  const plan = parsed.plan;

  // Step 2.
  const pack = await deps.runOrchestrator(plan);

  return { plan, pack, turn1Result };
}
