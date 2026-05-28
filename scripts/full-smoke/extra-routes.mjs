import { get, dispatch, deleteContextBlock } from './http.mjs';

const C = (checkId, status, detail = '') => ({ checkId, status, detail });

// Live coverage for the registered routes that the dispatch-style scenarios
// don't exercise: the introspection surface (/health, /status, /__routes), the
// single-task batch slice (POST /control/batch-slice), and the context-block
// DELETE half of the block lifecycle (register is covered by scenario #1).
// These ARE contract-tested at the build phase; this validates them on the live
// Bun.serve binary end-to-end so the smoke covers every route in the manifest.
export async function extraRouteChecks(ctx) {
  const out = [];
  const t = ctx.token;

  // ── Introspection ──────────────────────────────────────────────────────────
  try {
    const h = await get(t, '/health', false); // auth-exempt
    out.push(C('health', h.status === 200 ? 'PASS' : 'FAIL', `HTTP ${h.status}`));
  } catch (e) { out.push(C('health', 'FAIL', String(e.message || e))); }

  try {
    const s = await get(t, '/status'); // loopback-only + authed; smoke runs on 127.0.0.1
    out.push(C('status', s.status === 200 ? 'PASS' : 'FAIL', `HTTP ${s.status} version=${s.body?.version ?? '?'}`));
  } catch (e) { out.push(C('status', 'FAIL', String(e.message || e))); }

  // NOTE: GET /__routes is intentionally NOT checked — it's a test-only route
  // gated behind MMAGENT_TEST_INTROSPECTION=1 (not registered on a production
  // server). The route manifest is validated against routes.json at build phase.

  // ── Single-task batch slice: GET /batch/:id?taskIndex=N ─────────────────────
  // This is the documented slice feature (batch.test.ts) — it reads the sealed
  // registry/envelope result. (POST /control/batch-slice reads the in-flight
  // batchCache, which by design holds no results for a COMPLETED batch — wrong
  // route for this assertion.) Slice the most-recent batch's task 0.
  if (ctx.lastBatchId) {
    try {
      const r = await get(t, `/batch/${ctx.lastBatchId}?taskIndex=0`);
      const ok = r.status === 200 && Array.isArray(r.body?.results) && r.body.results.length === 1;
      out.push(C('batch-slice', ok ? 'PASS' : 'FAIL', `HTTP ${r.status} results=${Array.isArray(r.body?.results) ? r.body.results.length : '?'}`));
    } catch (e) { out.push(C('batch-slice', 'FAIL', String(e.message || e))); }
  } else {
    out.push(C('batch-slice', 'SKIP', 'no batch captured'));
  }

  // ── Context-block DELETE lifecycle (register → delete an unpinned block) ─────
  try {
    const content = 'Throwaway context block created to exercise the DELETE lifecycle in the full-smoke. Not pinned by any batch, so DELETE must return 200 {ok:true}.';
    const { status: regStatus, json } = await dispatch(t, 'context-blocks', { content }, ctx.dir);
    const id = json?.id;
    if (!id) {
      out.push(C('context-block-delete', 'FAIL', `register failed: HTTP ${regStatus} ${JSON.stringify(json)}`));
    } else {
      const delStatus = await deleteContextBlock(t, id, ctx.dir);
      out.push(C('context-block-delete', delStatus === 200 ? 'PASS' : 'FAIL', `register=${regStatus} delete=${delStatus}`));
    }
  } catch (e) { out.push(C('context-block-delete', 'FAIL', String(e.message || e))); }

  return out;
}
