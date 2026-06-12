import { dispatch, getTask } from './http.mjs';
import { POLL, BASE_URL } from './config.mjs';
import { readToken } from './http.mjs';

const T = (prompt, extra = {}) => ({ prompt, reviewPolicy: 'reviewed', ...extra });

// Returns { type, body } for a scenario given run context.
export function buildRequest(spec, ctx) {
  const cwd = ctx.dir;
  switch (spec.id) {
    // A. Task Types
    case 1:  return { type: 'context-blocks', body: { content: ctx.specMd } };
    case 2:  return { type: 'investigate', body: { question: 'In src/math.ts, does divide handle a zero divisor? Cite the line.', filePaths: ['src/'] } };
    case 3:  return { type: 'research', body: { researchQuestion: 'What static program-analysis techniques have researchers proposed for detecting division-by-zero errors in software?', background: 'Surveying the literature on static detection of division-by-zero (abstract interpretation, symbolic execution, etc.) to inform guarding a small math module.' } };
    case 4:  return { type: 'audit', body: { subtype: 'spec', filePaths: [`${cwd}/spec.md`], contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 5:  return { type: 'delegate', body: { tasks: [
               T('Create file src/a.ts with exactly: export const A=1. Only that file.', { filePaths: ['src/a.ts'], reviewPolicy: 'reviewed' })] } };
    case 6:  return { type: 'execute_plan', body: { filePaths: [`${cwd}/plan.md`], taskDescriptors: ['Task 1: add subtract'] } };
    case 7:  return { type: 'review', body: { filePaths: [`${cwd}/src/math.ts`] } };
    case 8:  return { type: 'debug', body: { problem: 'divide(1,0) returned Infinity, expected a thrown error', filePaths: ['src/math.ts'] } };
    case 9:  return { type: 'journal_record', body: { learnings: ['In src/math.ts, divide() has no zero-divisor guard; we decided to add an explicit throw rather than returning Infinity. Lesson: guard invalid inputs at the function boundary.'], tagHints: ['math', 'validation'] } };
    case 10: return { type: 'journal_recall', body: { query: 'what have we learned about guarding invalid inputs in the math module?' } };

    // B. Tier & Review Policy overrides
    case 11: return { type: 'delegate', body: { tasks: [
               T('Create file src/c.ts with exactly: export const C=3. Only that file.', { agentTier: 'complex', filePaths: ['src/c.ts'], reviewPolicy: 'reviewed' }) ] } };
    case 12: return { type: 'delegate', body: { tasks: [
               T('Create file src/f.ts with exactly: export const F=6. Only that file.', { filePaths: ['src/f.ts'], reviewPolicy: 'none' }) ] } };

    // C. Session Reuse — reuse implementer session from scenario #2
    case 13: {
      const sessionIds = ctx.sessionFromScenario2
        ? { implementer: ctx.sessionFromScenario2 }
        : undefined;
      return { type: 'investigate', body: {
        question: 'Given your earlier analysis, what is the return type of the divide function in src/math.ts?',
        filePaths: ['src/math.ts'],
        ...(sessionIds ? { sessionIds } : {}),
      } };
    }

    // D. Error Cases — these are raw payloads that should fail validation
    case 14: return { type: 'error_invalid_type', body: {}, rawPayload: { type: 'nonexistent', question: 'hello' } };
    case 15: return { type: 'error_missing_field', body: {}, rawPayload: { type: 'investigate' /* missing question */ } };

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
  for (;;) {
    const { status, body } = await getTask(token, taskId);
    if (status === 200) return body;
    if (status !== 202) throw new Error(`poll ${taskId}: HTTP ${status}`);
    if (Date.now() - start >= POLL.taskMaxMs) throw new Error(`poll ${taskId}: timeout`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 30000);
  }
}
