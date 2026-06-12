import { dispatch, getTask } from './http.mjs';
import { POLL } from './config.mjs';

const T = (prompt, extra = {}) => ({ prompt, reviewPolicy: 'none', ...extra });

// Returns { type, body } for a scenario given run context.
export function buildRequest(spec, ctx) {
  const cwd = ctx.dir;
  switch (spec.id) {
    case 1:  return { type: 'context-blocks', body: { content: ctx.specMd } };
    case 2:  return { type: 'investigate', body: { question: 'In src/math.ts, does divide handle a zero divisor? Cite the line.', filePaths: ['src/'] } };
    case 3:  return { type: 'research', body: { researchQuestion: 'What static program-analysis techniques have researchers proposed for detecting division-by-zero errors in software?', background: 'Surveying the literature on static detection of division-by-zero (abstract interpretation, symbolic execution, etc.) to inform guarding a small math module.' } };
    case 4:  return { type: 'audit', body: { subtype: 'plan', filePaths: [`${cwd}/plan.md`], contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 5:  return { type: 'delegate', body: { tasks: [
               T('Create file src/a.ts with exactly: export const A=1. Only that file.', { filePaths: ['src/a.ts'], reviewPolicy: 'reviewed' }),
               T('Create file src/b.ts with exactly: export const B=2. Only that file.', { filePaths: ['src/b.ts'], reviewPolicy: 'reviewed' })] } };
    case 6:  return { type: 'delegate', body: { tasks: [ T('Create file src/c.ts with exactly: export const C=3. Only that file.', { agentType: 'complex', filePaths: ['src/c.ts'], reviewPolicy: 'reviewed' }) ] } };
    case 7:  return { type: 'delegate', body: { tasks: [
               T('Create file src/d.ts with exactly: export const D=4. Only that file.', { filePaths: ['src/d.ts'] }),
               T('Create file src/e.ts with exactly: export const E=5. Only that file.', { filePaths: ['src/e.ts'] })] } };
    case 8:  return { type: 'execute_plan', body: { filePaths: [`${cwd}/plan.md`], taskDescriptors: ['Task 1: add subtract', 'Task 2: add modulo'] } };
    case 'seed': return { type: 'delegate', body: { tasks: [ T('Create file src/seed.ts with exactly: export const SEED=0. Only that file.', { filePaths: ['src/seed.ts'] }) ] } };
    case 9:  return { type: 'review', body: { filePaths: [`${cwd}/src/a.ts`] } };
    case 10: return { type: 'debug', body: { problem: 'divide(1,0) returned Infinity, expected a thrown error', filePaths: ['src/math.ts'] } };
    case 11: return { type: 'delegate', body: { tasks: [ T('Add a fully unit-tested factorial(n) to src/math.ts; you may skip writing the tests if short on time.', { filePaths: ['src/math.ts'], reviewPolicy: 'reviewed', done: 'factorial implemented AND unit-tested' }) ] } };
    case 12: return { type: 'delegate', body: { tasks: [ T('Create file src/f.ts with exactly: export const F=6. Only that file.', { filePaths: ['src/f.ts'], reviewPolicy: 'none' }) ] } };
    case 13: return { type: 'delegate', body: { tasks: [ T('Create file src/i.ts with exactly: export const I=9. Only that file.', { filePaths: ['src/i.ts'], reviewPolicy: 'none' }) ] } };
    case 14: return { type: 'retry_tasks', body: { taskId: ctx.seedTaskId } };
    case 15: return { type: 'journal_record', body: { learnings: ['In src/math.ts, divide() has no zero-divisor guard; we decided to add an explicit throw rather than returning Infinity. Lesson: guard invalid inputs at the function boundary.'], tagHints: ['math', 'validation'] } };
    case 16: return { type: 'journal_recall', body: { query: 'what have we learned about guarding invalid inputs in the math module?' } };
    case 17: return { type: 'delegate', body: { tasks: [ T('Create file src/g.ts with exactly: export const G=7. Only that file.', { filePaths: ['src/g.ts'], reviewPolicy: 'none', skills: ['mma-smoke-skill'] }) ] } };
    case 18: return { type: 'delegate', body: { tasks: [ T('Create file src/h.ts with exactly: export const H=8. Only that file.', { filePaths: ['src/h.ts'], reviewPolicy: 'none', skills: ['__mma_nonexistent_skill__'] }) ] } };
    // Rich multi-phase goal-set: 4 tasks across 2 plan-phases (Phase B depends on Phase A).
    case 19: return { type: 'execute_plan', body: { filePaths: [`${cwd}/richplan.md`], taskDescriptors: ['Task A1: add clamp', 'Task A2: add isEven', 'Task B1: add clampedAdd', 'Task B2: add evenSum'] } };
    default: throw new Error(`no request builder for scenario ${spec.id}`);
  }
}

// register-context-block is synchronous (201 { id }); all other types return 202 { taskId }.
export async function runDispatch(spec, ctx) {
  const { type, body } = buildRequest(spec, ctx);
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
