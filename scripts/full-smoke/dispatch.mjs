import { dispatch, getBatch } from './http.mjs';
import { POLL } from './config.mjs';

const T = (prompt, extra = {}) => ({ prompt, reviewPolicy: 'none', ...extra });

// Returns { route, body } for a scenario given run context.
export function buildRequest(spec, ctx) {
  const cwd = ctx.dir;
  switch (spec.id) {
    case 1:  return { route: 'context-blocks', body: { content: ctx.specMd } };
    case 2:  return { route: 'investigate', body: { question: 'In src/math.ts, does divide handle a zero divisor? Cite the line.', filePaths: ['src/'] } };
    case 3:  return { route: 'research', body: { researchQuestion: 'What are common strategies for guarding division-by-zero in TypeScript code?', background: 'Reviewing a small math module that performs division without checking the divisor for zero.' } };
    case 4:  return { route: 'audit', body: { subtype: 'plan', filePaths: [`${cwd}/plan.md`], contextBlockIds: ctx.blockId ? [ctx.blockId] : [] } };
    case 5:  return { route: 'delegate', body: { tasks: [
               T('Create file src/a.ts with exactly: export const A=1. Only that file.', { filePaths: ['src/a.ts'], reviewPolicy: 'full' }),
               T('Create file src/b.ts with exactly: export const B=2. Only that file.', { filePaths: ['src/b.ts'], reviewPolicy: 'full' })] } };
    case 6:  return { route: 'delegate', body: { tasks: [ T('Create file src/c.ts with exactly: export const C=3. Only that file.', { agentType: 'complex', filePaths: ['src/c.ts'], reviewPolicy: 'full' }) ] } };
    case 7:  return { route: 'delegate', body: { tasks: [
               T('Create file src/d.ts with exactly: export const D=4. Only that file.', { filePaths: ['src/d.ts'] }),
               T('Create file src/e.ts with exactly: export const E=5. Only that file.', { filePaths: ['src/e.ts'] })] } };
    case 8:  return { route: 'execute-plan', body: { filePaths: [`${cwd}/plan.md`], taskDescriptors: ['Task 1: add subtract', 'Task 2: add modulo'] } };
    case 'seed': return { route: 'delegate', body: { tasks: [ T('Create file src/seed.ts with exactly: export const SEED=0. Only that file.', { filePaths: ['src/seed.ts'] }) ] } };
    case 9:  return { route: 'review', body: { filePaths: [`${cwd}/src/a.ts`] } };
    case 10: return { route: 'debug', body: { problem: 'divide(1,0) returned Infinity, expected a thrown error', filePaths: ['src/math.ts'] } };
    case 11: return { route: 'delegate', body: { tasks: [ T('Add a fully unit-tested factorial(n) to src/math.ts; you may skip writing the tests if short on time.', { filePaths: ['src/math.ts'], reviewPolicy: 'full', done: 'factorial implemented AND unit-tested' }) ] } };
    case 12: return { route: 'delegate', body: { tasks: [ T('Create file src/f.ts with exactly: export const F=6. Only that file.', { filePaths: ['src/f.ts'], reviewPolicy: 'none' }) ] } };
    case 13: return { route: 'delegate', body: { tasks: [ T('Create file src/i.ts with exactly: export const I=9. Only that file.', { filePaths: ['src/i.ts'], reviewPolicy: 'none' }) ] } };
    case 14: return { route: 'retry', body: { batchId: ctx.seedBatchId } };
    case 15: return { route: 'journal-record', body: { learnings: ['In src/math.ts, divide() has no zero-divisor guard; we decided to add an explicit throw rather than returning Infinity. Lesson: guard invalid inputs at the function boundary.'], tagHints: ['math', 'validation'] } };
    case 16: return { route: 'journal-recall', body: { query: 'what have we learned about guarding invalid inputs in the math module?' } };
    case 17: return { route: 'delegate', body: { tasks: [ T('Create file src/g.ts with exactly: export const G=7. Only that file.', { filePaths: ['src/g.ts'], reviewPolicy: 'none', skills: ['mma-smoke-skill'] }) ] } };
    case 18: return { route: 'delegate', body: { tasks: [ T('Create file src/h.ts with exactly: export const H=8. Only that file.', { filePaths: ['src/h.ts'], reviewPolicy: 'none', skills: ['__mma_nonexistent_skill__'] }) ] } };
    // Rich multi-phase goal-set: 4 tasks across 2 plan-phases (Phase B depends on Phase A).
    case 19: return { route: 'execute-plan', body: { filePaths: [`${cwd}/richplan.md`], taskDescriptors: ['Task A1: add clamp', 'Task A2: add isEven', 'Task B1: add clampedAdd', 'Task B2: add evenSum'] } };
    default: throw new Error(`no request builder for scenario ${spec.id}`);
  }
}

// register-context-block is synchronous (201 { id }); all other routes return 202 { batchId }.
export async function runDispatch(spec, ctx) {
  const { route, body } = buildRequest(spec, ctx);
  const { status, json } = await dispatch(ctx.token, route, body, ctx.dir);
  if (route === 'context-blocks') {
    if (!json.id) throw new Error(`register-context-block failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { blockId: json.id };
  }
  if (status >= 400 || !json.batchId) throw new Error(`dispatch ${spec.id} (${route}) failed: HTTP ${status} ${JSON.stringify(json)}`);
  return { batchId: json.batchId };
}

export async function pollBatch(token, batchId) {
  const start = Date.now();
  let delay = POLL.batchEveryMs;
  for (;;) {
    const { status, body } = await getBatch(token, batchId);
    if (status === 200) return body;
    if (status !== 202) throw new Error(`poll ${batchId}: HTTP ${status}`);
    if (Date.now() - start >= POLL.batchMaxMs) throw new Error(`poll ${batchId}: timeout`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.4, 30000);
  }
}
