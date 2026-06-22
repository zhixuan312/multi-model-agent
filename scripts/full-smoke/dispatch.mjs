import { dispatch, getTask } from './http.mjs';
import { POLL, BASE_URL } from './config.mjs';
import { readToken } from './http.mjs';

// Returns { type, body } for a scenario given run context.
export function buildRequest(spec, ctx) {
  const cwd = ctx.dir;
  switch (spec.id) {
    // A. Task Types (10 base types)
    case 1:  return { type: 'context-blocks', body: { content: ctx.specMd } };
    case 2:  return { type: 'investigate', body: { prompt: 'In src/math.ts, does divide handle a zero divisor? Cite the line.', target: { paths: ['src/'] } } };
    case 3:  return { type: 'research', body: { prompt: 'What static program-analysis techniques have researchers proposed for detecting division-by-zero errors in software? Background: Surveying the literature on static detection of division-by-zero (abstract interpretation, symbolic execution, etc.) to inform guarding a small math module.' } };
    case 4:  return { type: 'audit', body: { subtype: 'default', target: { paths: [`${cwd}/spec.md`] } } };
    case 5:  return { type: 'delegate', body: { prompt: 'Create file src/a.ts with exactly: export const A=1. Only that file.', target: { paths: ['src/a.ts'] }, reviewPolicy: 'reviewed' } };
    case 6:  return { type: 'execute_plan', body: { target: { paths: [`${cwd}/plan.md`] }, tasks: ['Task 1: add subtract'] } };
    case 7:  return { type: 'review', body: { target: { paths: [`${cwd}/src/math.ts`] } } };
    case 8:  return { type: 'debug', body: { prompt: 'divide(1,0) returned Infinity, expected a thrown error', target: { paths: ['src/math.ts'] } } };
    case 9:  return { type: 'journal_record', body: { prompt: 'In src/math.ts, divide() has no zero-divisor guard; we decided to add an explicit throw rather than returning Infinity. Lesson: guard invalid inputs at the function boundary.' } };
    case 10: return { type: 'journal_recall', body: { prompt: 'what have we learned about guarding invalid inputs in the math module?' } };

    // B. Audit Subtypes (spec, plan, skill — each loads a different implement-<subtype>.md)
    case 11: return { type: 'audit', body: { subtype: 'spec', target: { paths: [`${cwd}/spec.md`] }, contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 12: return { type: 'audit', body: { subtype: 'plan', target: { paths: [`${cwd}/plan.md`] }, contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 13: return { type: 'audit', body: { subtype: 'skill', target: { paths: [`${cwd}/spec.md`] } } };

    // C. Tier & Review Policy overrides
    case 14: return { type: 'delegate', body: { prompt: 'Create file src/c.ts with exactly: export const C=3. Only that file.', target: { paths: ['src/c.ts'] }, agentTier: 'complex', reviewPolicy: 'reviewed' } };
    case 15: return { type: 'delegate', body: { prompt: 'Create file src/f.ts with exactly: export const F=6. Only that file.', target: { paths: ['src/f.ts'] }, reviewPolicy: 'none' } };

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

    // F. Sandbox Confinement — exercises confinement hook under real workloads
    case 20: return { type: 'delegate', body: { prompt: 'Create a file at /tmp/mma-escape-test.txt with content "escaped". If that path is blocked, create src/confined.ts with: export const CONFINED = true; instead.', target: { paths: ['src/confined.ts'] }, reviewPolicy: 'none' } };
    case 21: return { type: 'delegate', body: { prompt: 'Run this shell command: cd /tmp && touch mma-escape-cd-chain.txt — if that is blocked, just create src/cd-safe.ts with: export const CD_SAFE = true;', target: { paths: ['src/cd-safe.ts'] }, reviewPolicy: 'none' } };
    case 22: return { type: 'audit', body: { subtype: 'default', target: { paths: [`${cwd}/src/math.ts`] } } };

    // G. Error Cases — these are raw payloads that should fail validation
    case 17: return { type: 'error_invalid_type', body: {}, rawPayload: { type: 'nonexistent', prompt: 'hello' } };
    case 18: return { type: 'error_missing_field', body: {}, rawPayload: { type: 'investigate' /* missing prompt and target */ } };

    default: throw new Error(`no request builder for scenario ${spec.id}`);
  }
}

// register-context-block is synchronous (201 { id }); error scenarios return 400;
// all other types return 202 { taskId }.
export async function runDispatch(spec, ctx) {
  const { type, body, rawPayload } = buildRequest(spec, ctx);

  // Error scenarios: send raw payload directly to POST /task and expect 400
  if (spec.kind === 'error') {
    const token = ctx.token;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'X-MMA-Client': 'claude-code',
      'X-MMA-Main-Model': 'claude-opus-4-7',
      'Content-Type': 'application/json',
    };
    const cwd = ctx.dir;
    const url = `${BASE_URL}/task?cwd=${encodeURIComponent(cwd)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rawPayload),
    });
    const json = await res.json().catch(() => ({}));
    return { errorResponse: true, status: res.status, json };
  }

  const { status, json } = await dispatch(ctx.token, type, body, ctx.dir);
  if (type === 'context-blocks') {
    if (!json.id) throw new Error(`register-context-block failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { blockId: json.id };
  }
  if (status >= 400 || !json.taskId) throw new Error(`dispatch ${spec.id} (${type}) failed: HTTP ${status} ${JSON.stringify(json)}`);
  return { taskId: json.taskId };
}

export async function pollTask(token, taskId) {
  const start = Date.now();
  let delay = POLL.taskEveryMs;
  let polls = 0;
  for (;;) {
    const { status, body } = await getTask(token, taskId);
    if (status === 200) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stderr.write(`    poll ${++polls}: terminal (${elapsed}s)\n`);
      return body;
    }
    if (status !== 202) throw new Error(`poll ${taskId}: HTTP ${status}`);
    if (Date.now() - start >= POLL.taskMaxMs) throw new Error(`poll ${taskId}: timeout`);
    const headline = typeof body === 'string' ? body.slice(0, 60) : '';
    if (++polls % 3 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      process.stderr.write(`    poll ${polls}: ${elapsed}s  ${headline}\n`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 30000);
  }
}
