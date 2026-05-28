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

  // ── Batch slice (single-task view of a recent batch) ────────────────────────
  // Use the MOST RECENT batch (ctx.lastBatchId), not the seed — after 18
  // scenarios the seed batch is evicted from the per-project cache (404).
  if (ctx.lastBatchId) {
    try {
      const { status, json } = await dispatch(t, 'control/batch-slice', { batchId: ctx.lastBatchId, taskIndex: 0 }, ctx.dir);
      out.push(C('batch-slice', status === 200 && json?.result ? 'PASS' : 'FAIL', `HTTP ${status} hasResult=${!!json?.result}`));
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
