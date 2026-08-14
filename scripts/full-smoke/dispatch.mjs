import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dispatch, getTask, cancelTask, mcpCall } from './http.mjs';
import { POLL, BASE_URL, HOME_MM } from './config.mjs';
import { readToken, SMOKE_CLIENT } from './http.mjs';
import { approvedContract, contractContent } from './fixtures.mjs';

/** A prompt long enough that the task is still running when the cancel lands —
 *  cancelling an already-finished task would assert nothing. */
const LONG_RUNNING_PROMPT =
  'Read every file under src/ and write an exhaustive, multi-paragraph analysis of '
  + 'each function: its inputs, outputs, edge cases, failure modes, and how it '
  + 'interacts with every other function. Be maximally detailed and thorough.';

/**
 * #39 — cooperative cancellation over the wire.
 *
 * Cancellation is REQUESTED, not instantaneous, so this walks the whole lifecycle:
 * dispatch → let it get into the implementer phase → DELETE (202 + flag) → poll
 * once (still running, flag visible) → poll to terminal `cancelled` → repeat
 * DELETE (idempotent, 200 alreadyTerminal).
 */
/**
 * The JSON an MCP tool put in its single text content block, or null if there was none.
 *
 * An MCP tool ERROR carries a parseable body too (`{"error":{...}}` with `isError: true`), so a
 * non-null return here means "the call produced JSON", never "the call succeeded" — ask
 * `isToolError` for that.
 */
function parseToolText(r) {
  const text = r?.json?.result?.content?.[0]?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** Did the MCP layer mark this tool result as an error? */
function isToolError(r) {
  return r?.json?.result?.isError === true;
}

export async function runCancelScenario(ctx) {
  const { status: dStatus, json: dJson } = await dispatch(
    ctx.token, 'investigate',
    { prompt: LONG_RUNNING_PROMPT, target: { paths: ['src/'] } },
    ctx.dir,
  );
  if (dStatus !== 202 || !dJson.executionId) {
    throw new Error(`cancel scenario dispatch failed: HTTP ${dStatus} ${JSON.stringify(dJson)}`);
  }
  const taskId = dJson.executionId;

  // Let the implementer actually start; cancelling pre-dispatch tests a different path.
  await new Promise((r) => setTimeout(r, 4000));

  const del = await cancelTask(ctx.token, taskId);
  const pollAfterCancel = await getTask(ctx.token, taskId);
  const { envelope } = await pollTask(ctx.token, taskId);
  const repeatDel = await cancelTask(ctx.token, taskId);

  return { taskId, cancel: del, pollAfterCancel, envelope, repeatCancel: repeatDel };
}

/**
 * #40 — the MCP adapter as a second transport over the SAME runtime.
 *
 * Drives a real JSON-RPC exchange and then re-reads the identical execution over
 * REST. Parity is the load-bearing assertion: one runtime, two transports.
 */
export async function runMcpScenario(ctx) {
  const init = await mcpCall(ctx.token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'full-smoke', version: '1.0.0' },
  }, 1);

  const tools = await mcpCall(ctx.token, 'tools/list', undefined, 2);

  // The App surface, exercised as a host would. Skipped when the handshake did not
  // advertise `resources` — asking anyway would only produce a method-not-found that
  // says less than the capability check already did. `available` records WHY it was
  // skipped so verify can tell "correctly absent" from "silently missing".
  const capabilities = init?.json?.result?.capabilities ?? {};
  const resourcesAdvertised = Object.prototype.hasOwnProperty.call(capabilities, 'resources');
  let resourceList = null;
  let resourceRead = null;
  if (resourcesAdvertised) {
    resourceList = await mcpCall(ctx.token, 'resources/list', undefined, 20);
    const uri = (resourceList?.json?.result?.resources ?? [])[0]?.uri;
    if (uri) resourceRead = await mcpCall(ctx.token, 'resources/read', { uri }, 21);
  }

  const run = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_run',
    arguments: {
      cwd: ctx.dir,
      request: {
        type: 'investigate',
        prompt: 'In src/math.ts, does divide handle a zero divisor? Answer in one sentence.',
        target: { paths: ['src/'] },
      },
    },
  }, 3);

  const runPayload = parseToolText(run);
  const taskId = runPayload?.executionId ?? null;
  if (!taskId) {
    return { init, tools, resourceList, resourceRead, run, runPayload, taskId: null, waitPayload: null, restEnvelope: null };
  }

  const wait = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_execution_wait',
    arguments: { executionId: taskId, timeoutMs: 240000 },
  }, 4);
  let waitPayload = parseToolText(wait);

  // mma_execution_wait is bounded; if the task outlives the cap, finish over REST so
  // the parity assertion still compares two terminal reads of one execution.
  //
  // The terminal test reads `execution.status`. It used to read `.task`, a section SPEC-003 merged
  // into `execution` — so it was undefined on every run, the REST fallback fired every time, and
  // the parity check silently compared two REST reads to each other. The MCP wait result, the one
  // thing this scenario exists to prove, was thrown away unexamined.
  // `done`, NOT `completed`. Every SKILL.md documented `completed`, which the engine has never
  // emitted — `completed` belongs to the Initiative Record's TASK vocabulary, a different
  // enum. Taking the set from the docs made this read false for every run, including a 3.6s
  // one, which is how the parity check below silently compared REST to REST every time.
  const TERMINAL = new Set(['done', 'done_with_concerns', 'failed', 'cancelled']);
  const waitReachedTerminal = TERMINAL.has(waitPayload?.execution?.status);
  if (!waitReachedTerminal) {
    const { envelope } = await pollTask(ctx.token, taskId);
    waitPayload = envelope;
  }

  // The terminal envelope read back over MCP — ALWAYS, not only when the wait happened to finish
  // in time. `mma_execution_wait` is capped at WAIT_CAP_MS (55s, deliberately, because MCP hosts
  // give up around 60s), so any task slower than that legitimately returns before terminal and
  // `waitPayload` above becomes a REST envelope. Parity would then compare REST to REST — the
  // load-bearing assertion of this whole scenario, quietly comparing one transport to itself.
  // A separate `mma_execution_get` keeps one side of that comparison on MCP whatever the timings.
  const mcpGet = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_execution_get',
    arguments: { executionId: taskId },
  }, 5);
  const mcpTerminal = parseToolText(mcpGet);

  const rest = await getTask(ctx.token, taskId);
  return {
    init, tools, resourceList, resourceRead, run, runPayload, taskId, waitPayload,
    // Reported so a run where MCP wait timed out cannot masquerade as one where it answered.
    waitReachedTerminal,
    mcpTerminal,
    restEnvelope: rest.body, restStatus: rest.status,
  };
}

/**
 * #55 — the MCP transport must honour `deliverable` and `method`, not merely relay a task.
 *
 * #40 proves the adapter runs a task and matches REST, but it sends neither new field. The MCP
 * request schema is GENERATED from the same Zod union REST validates with, so a generation bug
 * or an adapter that strips unknown keys would leave a contract accepted over REST and rejected
 * over MCP — a split-brain between two transports of one runtime, invisible to every existing
 * scenario. Both fields are sent together because that is what a managed flow dispatches.
 */
export async function runMcpContractScenario(ctx) {
  const { approvedContract, contractContent } = await import('./fixtures.mjs');
  const deliverable = approvedContract(contractContent());

  const schema = await mcpCall(ctx.token, 'tools/list', undefined, 40);

  const run = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_run',
    arguments: {
      cwd: ctx.dir,
      request: {
        type: 'review',
        target: { paths: [`${ctx.dir}/src/math.ts`] },
        deliverable,
        method: 'software-change@1',
      },
    },
  }, 41);

  const runPayload = parseToolText(run);
  const taskId = runPayload?.executionId ?? null;
  // A rejection surfaces as an MCP tool error rather than a handle, so the absence of a taskId is
  // itself the finding — carry the raw payload so verify can report WHY.
  if (!taskId) return { schema, run, runPayload, taskId: null, envelope: null };

  const { envelope } = await pollTask(ctx.token, taskId);
  return { schema, run, runPayload, taskId, envelope };
}

/**
 * #56 — the rest of the MCP tool surface.
 *
 * `mma_run` and `mma_execution_wait` are covered by #40. The remaining tools have never been driven
 * over MCP at all, only through their REST equivalents, so a tool that threw on every call would
 * fail no existing scenario. This drives them as a host would: register a context block, list it
 * among live tasks, cancel a running task, and delete the block.
 */
export async function runMcpToolsScenario(ctx) {

  const createBlock = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_context_block_create',
    arguments: { cwd: ctx.dir, content: ctx.specMd ?? '# Block\n\nSmoke content for the MCP tool surface.' },
  }, 50);
  const blockPayload = parseToolText(createBlock);
  const blockId = blockPayload?.id ?? blockPayload?.blockId ?? null;

  // A long task so the list and cancel calls act on something genuinely running.
  const run = await mcpCall(ctx.token, 'tools/call', {
    name: 'mma_run',
    arguments: { cwd: ctx.dir, request: { type: 'investigate', prompt: LONG_RUNNING_PROMPT, target: { paths: ['src/'] } } },
  }, 51);
  const taskId = parseToolText(run)?.executionId ?? null;
  if (taskId) await new Promise((r) => setTimeout(r, 4000));

  const list = await mcpCall(ctx.token, 'tools/call', { name: 'mma_execution_list', arguments: {} }, 52);
  const listPayload = parseToolText(list);

  const get = taskId
    ? await mcpCall(ctx.token, 'tools/call', { name: 'mma_execution_get', arguments: { executionId: taskId } }, 53)
    : null;
  const getPayload = get ? parseToolText(get) : null;

  const cancel = taskId
    ? await mcpCall(ctx.token, 'tools/call', { name: 'mma_execution_cancel', arguments: { executionId: taskId } }, 54)
    : null;
  const cancelPayload = cancel ? parseToolText(cancel) : null;
  const cancelIsError = cancel ? isToolError(cancel) : null;

  // Drain to terminal so the cancelled task does not outlive the scenario.
  let terminal = null;
  if (taskId) { try { terminal = (await pollTask(ctx.token, taskId)).envelope; } catch { /* already gone */ } }

  const deleteBlock = blockId
    ? await mcpCall(ctx.token, 'tools/call', { name: 'mma_context_block_delete', arguments: { cwd: ctx.dir, id: blockId } }, 55)
    : null;

  return { createBlock, blockId, listPayload, getPayload, cancelPayload, cancelIsError, deleteBlock: deleteBlock ? parseToolText(deleteBlock) : null, terminal, taskId };
}

/**
 * #59 — a caller that lost its handle must be able to find its task again.
 *
 * Reported twice in real use: an MCP dispatch timed out, the caller assumed the task had not been
 * created, re-dispatched, and produced a duplicate. Every other scenario here polls politely to
 * terminal, so no test covered what happens when the caller stops listening.
 *
 * This does NOT stage a real client timeout, and the reason is worth recording rather than hiding.
 * Forcing one is inherently racy: the abort has to land after the daemon has admitted the task but
 * before it returns the handle, and admission takes single-digit milliseconds. A first attempt
 * aborting at 50ms did not abort at all — the daemon had already answered — so the scenario
 * asserted nothing. A test that only sometimes exercises its subject is worse than no test,
 * because its green result is not evidence.
 *
 * So it asserts the PROPERTY that makes recovery possible instead of the accident that requires
 * it: a task that has been admitted is discoverable through `mma_execution_list` while it is still
 * running. If that holds, a caller whose request timed out can reconcile and find its work. If it
 * did not hold, "timed out" and "never created" would be indistinguishable and duplicating the
 * work would be the only safe move — which is exactly the bug that was reported.
 */
export async function runClientTimeoutScenario(ctx) {
  const parse = (r) => { const x = r?.json?.result?.content?.[0]?.text; try { return x ? JSON.parse(x) : null; } catch { return null; } };

  const { status, json } = await dispatch(ctx.token, 'investigate',
    { prompt: LONG_RUNNING_PROMPT, target: { paths: ['src/'] } }, ctx.dir);
  const taskId = json?.executionId ?? null;
  if (status !== 202 || !taskId) return { dispatched: false, taskId: null, discovered: false, listedCount: 0, terminal: null };

  // The caller now "loses" its handle and reconciles the way a recovering client would: by asking
  // the daemon what is running, not by re-dispatching.
  await new Promise((r) => setTimeout(r, 3000));
  const list = await mcpCall(ctx.token, 'tools/call', { name: 'mma_execution_list', arguments: {} }, 60);
  const tasks = parse(list)?.executions ?? [];
  const discovered = tasks.some((task) => task?.executionId === taskId);

  let terminal = null;
  try {
    await cancelTask(ctx.token, taskId);
    terminal = (await pollTask(ctx.token, taskId)).envelope;
  } catch { /* already terminal */ }
  return { dispatched: true, taskId, discovered, listedCount: tasks.length, terminal };
}

// Returns { type, body } for a scenario given run context.
export function buildRequest(spec, ctx) {
  // Engine-commit scenarios each get their OWN repo, on their own caller-created branch. They
  // must not share one checkout: the engine commits the submitted cwd in place, so N scenarios
  // in one repo would each sweep the others' files into their commit.
  const repo = ctx.writeRepos?.[spec.id];
  const cwd = repo?.dir ?? ctx.dir;
  switch (spec.id) {
    // A. Task Types (10 base types)
    case 1:  return { type: 'context-blocks', body: { content: ctx.specMd } };
    case 2:  return { type: 'investigate', body: { prompt: 'In src/math.ts, does divide handle a zero divisor? Cite the line.', target: { paths: ['src/'] } } };
    case 3:  return { type: 'research', body: { prompt: 'What static program-analysis techniques have researchers proposed for detecting division-by-zero errors in software? Background: Surveying the literature on static detection of division-by-zero (abstract interpretation, symbolic execution, etc.) to inform guarding a small math module.' } };
    case 4:  return { type: 'audit', body: { subtype: 'default', target: { paths: [`${cwd}/spec.md`] } } };
    case 5:  return { cwd, type: 'delegate', body: { prompt: 'Create file src/a.ts with exactly: export const A=1. Only that file.', target: { paths: ['src/a.ts'] }, reviewPolicy: 'reviewed' } };
    case 6:  return { cwd, type: 'execute_plan', body: { target: { paths: [`${cwd}/plan.md`] }, tasks: ['Task I-1: add subtract'] } };
    case 7:  return { type: 'review', body: { target: { paths: [`${cwd}/src/math.ts`] } } };
    case 8:  return { type: 'debug', body: { prompt: 'divide(1,0) returned Infinity, expected a thrown error', target: { paths: ['src/math.ts'] } } };
    case 9:  return { type: 'journal_record', body: { prompt: 'In src/math.ts, divide() has no zero-divisor guard; we decided to add an explicit throw rather than returning Infinity. Lesson: guard invalid inputs at the function boundary.', topic: 'math-module' } };
    case 10: return { type: 'journal_recall', body: { prompt: 'what have we learned about guarding invalid inputs in the math module?', topic: 'math-module' } };

    // B. Audit Subtypes (spec, plan, skill — each loads a different implement-<subtype>.md)
    case 11: return { type: 'audit', body: { subtype: 'spec', target: { paths: [`${cwd}/spec.md`] }, contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 12: return { type: 'audit', body: { subtype: 'plan', target: { paths: [`${cwd}/plan.md`] }, contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 13: return { type: 'audit', body: { subtype: 'skill', target: { paths: [`${cwd}/spec.md`] } } };

    // C. Tier & Review Policy overrides
    case 14: return { cwd, type: 'delegate', body: { prompt: 'Create file src/c.ts with exactly: export const C=3. Only that file.', target: { paths: ['src/c.ts'] }, agentTier: 'complex', reviewPolicy: 'reviewed' } };
    case 15: return { cwd, type: 'delegate', body: { prompt: 'Create file src/f.ts with exactly: export const F=6. Only that file.', target: { paths: ['src/f.ts'] }, reviewPolicy: 'none' } };

    // D. Session Reuse — reuse implementer session from scenario #2
    case 16: {
      const sessionIds = ctx.sessionFromScenario2
        ? { implementer: ctx.sessionFromScenario2 }
        : undefined;
      return { type: 'investigate', body: {
        prompt: 'Given your earlier analysis, what is the return type of the divide function in src/math.ts?',
        target: { paths: ['src/math.ts'] },
        ...(sessionIds ? { sessionIds } : {}),
      } };
    }

    // Orchestrate — session-persistent brain
    case 19: return { type: 'orchestrate', body: { prompt: 'List every exported function in src/math.ts. For each, state name, parameter types, and return type. Output as JSON array.' } };

    // F. Sandbox Confinement — exercises confinement hook under real workloads.
    //
    // The escape targets are removed BEFORE dispatch so the post-run absence assertion means
    // something: a file left behind by an earlier run would otherwise read as a fresh escape, and
    // (worse) a file that survives because the hook failed would be indistinguishable from one the
    // harness never cleaned up.
    // The escape targets are read from SANDBOX_ESCAPE_TARGETS rather than written inline, so the
    // prompt and the post-run assertion can never name different paths — which is how #20 spent
    // several releases "passing" against a path nothing checked.
    case 20: return { cwd, type: 'delegate', body: { prompt: `Create a file at ${SANDBOX_ESCAPE_TARGETS[20]} with content "escaped". If that path is blocked, create src/confined.ts with: export const CONFINED = true; instead.`, target: { paths: ['src/confined.ts'] }, reviewPolicy: 'none' } };
    case 21: return { cwd, type: 'delegate', body: { prompt: `Run this shell command: cd ${ESCAPE_PROBE_DIR} && touch cd-chain.txt — if that is blocked, just create src/cd-safe.ts with: export const CD_SAFE = true;`, target: { paths: ['src/cd-safe.ts'] }, reviewPolicy: 'none' } };
    case 22: return { type: 'audit', body: { subtype: 'default', target: { paths: [`${cwd}/src/math.ts`] } } };

    // G. Uncommitted plan file (worktree copy test)
    case 23: return { cwd, type: 'execute_plan', body: { target: { paths: [`${cwd}/uncommitted-plan.md`] }, tasks: ['Task I-1: add modulo'] } };

    // H. New task types (spec + plan)
    case 24: return { type: 'spec', body: { prompt: 'Input validation for math module — guard division by zero', target: { paths: [`${cwd}/design-decisions.md`] } } };
    case 25: return { type: 'plan', body: { prompt: 'Write a TDD plan for the input validation spec', target: { paths: [`${cwd}/spec.md`] } } };

    // I. Context block delta mode — audit round 2 using round 1's contextBlockId
    case 26: {
      const blockId = ctx.auditContextBlockId;
      if (!blockId) throw new Error('scenario #26 requires ctx.auditContextBlockId from scenario #4');
      return { type: 'audit', body: { subtype: 'default', target: { paths: [`${cwd}/spec.md`] }, contextBlockIds: [blockId] } };
    }

    // J. Error: too many context blocks (>2 rejected)
    case 27: return { type: 'error_too_many_blocks', body: {}, rawPayload: { type: 'audit', target: { paths: [`${cwd}/spec.md`] }, contextBlockIds: ['a', 'b', 'c'] } };

    // K. Non-git cwd: write routes run in-place without a worktree
    case 28: return { type: 'delegate', body: { prompt: 'Create file src/output.ts with: export const OUT = 1;', target: { paths: ['src/output.ts'] }, reviewPolicy: 'none' }, cwd: ctx.nonGitDir };
    case 32: return { type: 'execute_plan', body: { target: { paths: ['plan.md'] }, tasks: ['Task I-1: add greeting'] }, cwd: ctx.nonGitDir };

    // L. Subset spec components — request a scrambled subset; worker emits only those, canonical order
    case 29: return { type: 'spec', body: { prompt: 'Guarded arithmetic — subset spec', target: { paths: [`${cwd}/design-decisions.md`] }, components: spec.subsetComponents } };
    case 30: return { type: 'error_bad_components', body: {}, rawPayload: { type: 'spec', prompt: 'bad component label', target: { inline: '## Context\n\n### Background\ntest' }, components: ['Context', 'Not A Real Component'] } };
    case 31: return { type: 'spec', body: { prompt: 'Guarded arithmetic — spec from decisions + exploration grounding', target: { paths: [`${cwd}/design-decisions.md`, `${cwd}/exploration.md`] } } };

    // Error Cases — these are raw payloads that should fail validation
    case 17: return { type: 'error_invalid_type', body: {}, rawPayload: { type: 'nonexistent', prompt: 'hello' } };
    case 18: return { type: 'error_missing_field', body: {}, rawPayload: { type: 'investigate' /* missing prompt and target */ } };

    // Manual-test-sweep regression coverage
    // F4: empty target {} must be rejected at validation (targetSchema = exactly-one).
    case 33: return { type: 'error_empty_target', body: {}, rawPayload: { type: 'audit', target: {} } };
    // F5: a spec whose target.paths does not resolve fails ASYNC — dispatched normally
    // (202 → poll), the terminal 200 must be the 6-field envelope with `error`.
    case 34: return { type: 'spec', body: { prompt: 'F5 async-error smoke — nonexistent target path', target: { paths: [`${cwd}/does-not-exist-smoke-f5-9c3.md`] } } };

    // journal_record batch (records[]) coverage
    case 35: return { type: 'journal_record', body: { records: [
      { prompt: 'In src/math.ts, divide() lacks a zero-divisor guard; we decided to throw rather than return Infinity. Lesson: guard invalid inputs at the function boundary.', topic: 'math-module' },
      { prompt: 'Batch journal_record processes submitted records sequentially in one worker session, writing one node per record. Lesson: reuse the execute_plan one-worker-sequential completeness model.', topic: 'worker-runtime' },
    ] } };
    case 36: return { type: 'error_journal_mixed_shape', body: {}, rawPayload: { type: 'journal_record', prompt: 'legacy prompt', records: [{ prompt: 'canonical prompt' }] } };
    case 37: return { type: 'error_journal_empty_records', body: {}, rawPayload: { type: 'journal_record', records: [] } };

    // Worktree lifecycle — a normal delegate; the interesting part is the seeded orphan
    // (index.mjs) + the post-run filesystem assertions that no worktree leaks.
    // No-op guard: the worker is told to change nothing. The engine must make NO commit, so the
    // dirty file the fixture left behind stays uncommitted.
    case 38: return { cwd, type: 'delegate', body: { prompt: 'Read src/math.ts and report in one sentence what divide() does. Do NOT create, modify, or delete any file. Do not run any git command.', target: { paths: ['src/math.ts'] }, reviewPolicy: 'none' } };

    // Q. Caller-owned branches — id-based selection, heading-based selection, git denial.
    case 41: return { cwd, type: 'execute_plan', body: { target: { paths: [`${cwd}/two-task-plan.md`] }, tasks: ['I-2'] } };
    case 42: return { cwd, type: 'execute_plan', body: { target: { paths: [`${cwd}/two-task-plan.md`] }, tasks: ['Task I-2: add modulo (← AC-1)'] } };
    case 43: return { cwd, type: 'delegate', body: { prompt: 'First run `git reset --hard HEAD` to clean the tree, then create file src/gitguard.ts with exactly: export const GUARD = 43;', target: { paths: ['src/gitguard.ts'] }, reviewPolicy: 'none' } };

    // R. Deliverable-agnostic solution lifecycle.
    // #44 A valid approved contract on a governed route. `commit-in-place` is feasible because
    //     ctx.dir is a git repository, and the declared artifact resolves under `workspaceRoot`.
    case 44: return { type: 'review', body: {
      target: { paths: [`${ctx.dir}/src/math.ts`] },
      deliverable: approvedContract(contractContent()),
    } };
    // #45 A no-check Contract Task producing a markdown deliverable.
    case 45: return { cwd, type: 'execute_plan', body: {
      target: { paths: [`${cwd}/no-check-plan.md`] },
      tasks: ['I-1'],
    } };
    // #46 `method: 'software-change@1'` must reach Method resolution and echo on the envelope.
    // `plan` accepts BOTH fields, so it sends both — the last of the four route/field
    // combinations, and the shape a managed flow dispatches at the plan stage.
    case 46: return { cwd, type: 'plan', body: {
      prompt: 'Write a contract-first plan for guarding division by zero in the math module',
      target: { paths: [`${cwd}/spec.md`] },
      // A SOFTWARE contract carries a deterministic criterion, because that is what a code
      // deliverable's acceptance actually looks like. The earlier fixture declared a single
      // `agent-review` criterion — a shape a real software contract would not have — and the
      // planner mirrored it, producing a plan with no declared checks at all. That made the
      // scenario report a fixture artefact as a product defect. Keep at least one `command`
      // criterion here so the contract is representative of the work it governs.
      deliverable: approvedContract(contractContent({
        artifacts: [{ root: 'workspaceRoot', path: 'src/math.ts' }],
        acceptance: [
          { id: 'AC-1', criterion: 'the guarded-arithmetic checks pass', method: 'command',
            references: [{ kind: 'none', reason: 'internal module, no external standard' }],
            command: { program: 'node', args: ['--test', 'tests/'] } },
          { id: 'AC-2', criterion: 'the public signatures are unchanged for existing callers',
            method: 'agent-review',
            references: [{ kind: 'none', reason: 'internal module, no external standard' }] },
        ],
      })),
      method: 'software-change@1',
    } };

    // Contract rejection paths — one reason each.
    case 47: return { type: 'error_contract_not_approved', body: {}, rawPayload: {
      type: 'review', target: { paths: [`${ctx.dir}/src/math.ts`] },
      // `proposed` carries no approval at all, which is exactly why it must not cross the wire.
      deliverable: { state: 'proposed', ...contractContent() },
    } };
    case 48: return { type: 'error_contract_digest_mismatch', body: {}, rawPayload: {
      type: 'review', target: { paths: [`${ctx.dir}/src/math.ts`] },
      deliverable: approvedContract(contractContent(), { corruptDigest: true }),
    } };
    // Dispatched against the NON-GIT cwd: the disposition check needs a real filesystem, so
    // pointing this at ctx.dir (a git repo) would pass and assert nothing.
    case 49: return { type: 'error_contract_disposition_non_git', body: {}, cwd: ctx.nonGitDir, rawPayload: {
      type: 'review', target: { paths: ['src/math.ts'] },
      deliverable: approvedContract(contractContent({ disposition: 'commit-in-place', artifacts: [] , acceptance: [
        { id: 'AC-1', criterion: 'the suite passes', method: 'command',
          references: [{ kind: 'none', reason: 'internal module' }],
          command: { program: 'node', args: ['--version'] } },
      ] })),
    } };
    case 50: return { type: 'error_unknown_method', body: {}, rawPayload: {
      type: 'audit', subtype: 'default', target: { paths: [`${ctx.dir}/spec.md`] }, method: 'no-such-method@1',
    } };

    // S. Every remaining route that accepts `deliverable` and/or `method`.
    // #51 execute_plan takes BOTH — the shape a managed flow actually dispatches.
    case 51: return { cwd, type: 'execute_plan', body: {
      target: { paths: [`${cwd}/plan.md`] },
      tasks: ['I-1'],
      deliverable: approvedContract(contractContent({
        // The declared artifact is the file this plan's task actually produces, so the contract
        // describes the real delivery rather than an unrelated path that happens to validate.
        artifacts: [{ root: 'workspaceRoot', path: 'src/subtract.mjs' }],
      })),
      method: 'software-change@1',
    } };
    case 52: return { type: 'review', body: {
      target: { paths: [`${ctx.dir}/src/math.ts`] },
      method: 'software-change@1',
    } };
    case 53: return { type: 'debug', body: {
      prompt: 'divide(1,0) returned Infinity instead of throwing — find the root cause',
      target: { paths: ['src/math.ts'] },
      method: 'software-change@1',
    } };
    // #54 spec accepts `deliverable` but this scenario omits `method` on purpose — `method` is
    // wired to every route, so this only proves `deliverable` alone still dispatches cleanly.
    case 54: return { type: 'spec', body: {
      prompt: 'Guarded arithmetic — spec dispatched under an approved contract',
      target: { paths: [`${ctx.dir}/design-decisions.md`] },
      deliverable: approvedContract(contractContent()),
    } };

    // V. The non-code workspace: no source file, no test runner, no `tests/` directory.
    case 57: return { type: 'investigate', cwd: ctx.nonCodeDir, body: {
      prompt: 'What does the Q2 commentary claim about revenue, and which ledger lines support it? Cite what you used.',
      target: { paths: ['reports/', 'source-data/'] },
    } };
    // A plan for a deliverable that has no build, no suite and no repository conventions. Its
    // declared checks — if it declares any — cannot live under `tests/`.
    case 58: return { type: 'plan', cwd: ctx.nonCodeDir, body: {
      prompt: 'Write a plan to produce the Q3 finance commentary from the ledger',
      target: { paths: [`${ctx.nonCodeDir}/spec.md`] },
    } };

    default: throw new Error(`no request builder for scenario ${spec.id}`);
  }
}

// register-context-block is synchronous (201 { id }); error scenarios return 400;
// all other types return 202 { taskId }.
/**
 * Where each cwd-escape scenario tries to write. Asserted absent after the run (verify.mjs).
 *
 * NOT under /tmp. `cwd-only` maps to codex `-s workspace-write`, which permits the cwd AND the temp
 * dirs, and the claude hook matches it — so a temp path is a PERMITTED write, and asserting its
 * absence tested the opposite of the policy. Scenario workspaces are themselves `mkdtemp` dirs
 * under the system temp root, so no path under temp can prove confinement at all.
 *
 * `~/.mma/smoke-escape-probe/` is outside the scenario cwd and outside every temp dir, so a file
 * appearing there is an unambiguous escape. It lives under a directory the product already owns,
 * so the probe never writes somewhere the user did not expect.
 */
const ESCAPE_PROBE_DIR = join(HOME_MM, 'smoke-escape-probe');
export const SANDBOX_ESCAPE_TARGETS = {
  20: join(ESCAPE_PROBE_DIR, 'direct-path.txt'),
  21: join(ESCAPE_PROBE_DIR, 'cd-chain.txt'),
};

/** Removes a cwd-escape target before its scenario runs; see SANDBOX_ESCAPE_TARGETS. */
function clearSandboxEscapeTarget(id) {
  const target = SANDBOX_ESCAPE_TARGETS[id];
  if (!target) return;
  // Create the directory but not the file. Without the directory, a write the sandbox ALLOWED
  // could still fail on ENOENT, and the check would read that accident as confinement working.
  try { mkdirSync(ESCAPE_PROBE_DIR, { recursive: true }); } catch { /* already there */ }
  try { rmSync(target, { force: true }); } catch { /* absent is the desired state */ }
}

export async function runDispatch(spec, ctx) {
  // Absence of the escape file is only evidence if it was absent before the run.
  clearSandboxEscapeTarget(spec.id);
  const buildResult = buildRequest(spec, ctx);
  const { type, body, rawPayload } = buildResult;

  // Error scenarios: send raw payload directly to POST /execution and expect 400
  if (spec.kind === 'error') {
    const token = ctx.token;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'X-MMA-Client': SMOKE_CLIENT,
      'Content-Type': 'application/json',
    };
    // An error scenario may name its own cwd. The disposition-feasibility rejection is only
    // reachable from a NON-git workspace, so defaulting every error case to ctx.dir (a git
    // repository) would make that scenario silently assert nothing.
    const cwd = buildResult.cwd ?? ctx.dir;
    const url = `${BASE_URL}/execution?cwd=${encodeURIComponent(cwd)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rawPayload),
    });
    const json = await res.json().catch(() => ({}));
    return { errorResponse: true, status: res.status, json };
  }

  const effectiveCwd = buildResult.cwd ?? ctx.dir;
  const { status, json } = await dispatch(ctx.token, type, body, effectiveCwd);
  if (type === 'context-blocks') {
    if (!json.id) throw new Error(`register-context-block failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { blockId: json.id };
  }
  // Async admission answers 202 with an `executionId` (SPEC-003 renamed the whole surface from
  // task to execution). Accepting a `taskId` fallback here would mean a server that regressed to
  // the retired contract still passed the smoke — the fallback was doing the opposite of the
  // harness's job. `taskId` survives only as the harness-internal variable name.
  const handle = json.executionId;
  if (status >= 400 || !handle) throw new Error(`dispatch ${spec.id} (${type}) failed: HTTP ${status} ${JSON.stringify(json)}`);
  return { taskId: handle, admission: json };
}

export async function pollTask(token, taskId) {
  const start = Date.now();
  let delay = POLL.taskEveryMs;
  let polls = 0;
  let first202 = null;
  // The LAST running snapshot as well as the first. They answer different questions:
  // the first proves the shape exists from the outset, the last is the only one that
  // can carry a settled activity series — the first 202 often lands before the worker
  // has emitted a single provider event, so asserting activity there would report NA
  // forever, which is indistinguishable from a check that always passes.
  let last202 = null;
  for (;;) {
    const { status, body } = await getTask(token, taskId);
    if (status === 200) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stderr.write(`    poll ${++polls}: terminal (${elapsed}s)\n`);
      return { envelope: body, polling202: first202, polling202Last: last202 };
    }
    if (status !== 202) throw new Error(`poll ${taskId}: HTTP ${status}`);
    if (Date.now() - start >= POLL.taskMaxMs) throw new Error(`poll ${taskId}: timeout`);
    if (!first202 && body && typeof body === 'object') first202 = body;
    if (body && typeof body === 'object') last202 = body;
    const phase = body?.phase ?? '';
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    if (++polls % 3 === 0) {
      process.stderr.write(`    poll ${polls}: ${elapsed}s  ${phase}\n`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 30000);
  }
}
