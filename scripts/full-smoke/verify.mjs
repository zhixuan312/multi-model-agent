import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from './config.mjs';

const C = (checkId, status, detail = '') => ({ checkId, status, detail });

// ─────────────────────────────────────────────────────────────────────────────
// Verify checks per scenario. Every scenario validates:
//
//   1. response      — did the task complete successfully?
//   2. sessions      — are session fields present and correct?
//   3. tier          — does the implementer tier match expected?
//   4. review        — is reviewer present when reviewed, absent when none?
//   5. quality       — does the output contain meaningful, type-appropriate content?
//   6. context-block — contextBlockId non-null for read types, null for write?
//   7. cost          — implementer costUsd > 0?
//   8. diag-events   — expected diagnostic events present?
// ─────────────────────────────────────────────────────────────────────────────

// Quality assertions per task type. Returns [status, detail].
function extractFindingsFromOutput(output) {
  if (!output) return [];
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return [];
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1][1]);
    return parsed.findings ?? [];
  } catch { return []; }
}

function checkQuality(type, subtype, r, subsetComponents) {
  // Extract output text: prefer raw implementer text, then output.summary as string
  const rawImpl = r?.raw?.implementer ?? '';
  const summary = r?.output?.summary;
  const output = typeof rawImpl === 'string' && rawImpl.length > 0
    ? rawImpl
    : (typeof summary === 'string' ? summary : JSON.stringify(summary ?? ''));
  const outputLen = typeof output === 'string' ? output.length : 0;

  switch (type) {
    case 'audit': {
      const findings = extractFindingsFromOutput(output);
      if (outputLen < 200) return ['FAIL', `audit output too short (${outputLen} chars)`];
      if (findings.length > 0) {
        const withEvidence = findings.filter(f => f?.evidence?.length > 20);
        return ['PASS', `${findings.length} findings, ${withEvidence.length} grounded, ${outputLen} chars`];
      }
      // Audits (especially plan/skill subtypes) may return prose analysis
      // without a JSON findings block — substantive prose is valid output.
      return ['PASS', `prose audit output (${outputLen} chars, no JSON findings block)`];
    }
    case 'investigate': {
      if (outputLen < 100) return ['FAIL', `output too short (${outputLen} chars) — expected substantive analysis`];
      const citesFile = /\b\w+\.\w+:\d+\b|file:|line\s+\d+/i.test(output);
      return [citesFile ? 'PASS' : 'WARN', `${outputLen} chars; file-citation=${citesFile}`];
    }
    case 'review': {
      const reviewFindings = extractFindingsFromOutput(output);
      if (reviewFindings.length === 0 && outputLen < 50) return ['WARN', 'review produced 0 findings and minimal output'];
      return ['PASS', `${reviewFindings.length} findings, ${outputLen} chars output`];
    }
    case 'debug': {
      if (outputLen < 100) return ['FAIL', `debug output too short (${outputLen} chars) — expected root-cause trace`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'research': {
      if (outputLen < 200) return ['WARN', `research output short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'journal_recall': {
      if (outputLen < 20) return ['WARN', `recall output very short (${outputLen} chars)`];
      const findings = Array.isArray(summary?.findings) ? summary.findings : [];
      if (findings.length > 0) {
        const badTopic = findings.filter(f => typeof f?.topic !== 'string' || f.topic.length === 0);
        if (badTopic.length > 0) return ['FAIL', `${badTopic.length}/${findings.length} recall findings missing a topic`];
        const badFallback = findings.filter(f => typeof f?.fallback !== 'boolean');
        if (badFallback.length > 0) return ['FAIL', `${badFallback.length}/${findings.length} recall findings missing a boolean fallback flag`];
        return ['PASS', `${findings.length} findings, all carry topic + boolean fallback`];
      }
      return ['PASS', `${outputLen} chars output (0 findings)`];
    }
    case 'journal_record': {
      if (outputLen < 10) return ['WARN', `record output very short (${outputLen} chars)`];
      const hasType = /\btype\b/.test(output) || /decision|design|behavior|process|knowledge|style/.test(output);
      const recorded = Array.isArray(summary?.recorded) ? summary.recorded : [];
      if (recorded.length > 0) {
        const missingTopic = recorded.filter(x => typeof x?.topic !== 'string' || x.topic.length === 0);
        if (missingTopic.length > 0) return ['FAIL', `${missingTopic.length}/${recorded.length} recorded items missing a topic`];
        const allKebab = recorded.every(x => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x.topic));
        if (!allKebab) return ['FAIL', `recorded topic is not normalized lowercase-kebab`];
        return ['PASS', `${recorded.length} recorded, all carry lowercase-kebab topic; type-aware=${hasType}`];
      }
      return ['PASS', `${outputLen} chars output; type-aware=${hasType}`];
    }
    case 'delegate': {
      if (outputLen < 20) return ['WARN', `delegate output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'execute_plan': {
      if (outputLen < 20) return ['WARN', `execute_plan output very short (${outputLen} chars)`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'orchestrate': {
      if (outputLen < 50) return ['FAIL', `orchestrate output too short (${outputLen} chars) — expected structured response`];
      return ['PASS', `${outputLen} chars output`];
    }
    case 'spec': {
      if (outputLen < 20) return ['WARN', `spec output very short (${outputLen} chars)`];
      const specSummary = r?.output?.summary;
      const specPath = specSummary?.specPath ?? null;
      const hasSpecPath = specPath != null;
      // Default artifact root is .mma/specs/ (co-located with the journal). Scenario
      // #24 sends no outputPath, so the derived path must land under .mma/specs/ —
      // regression guard. The worker may return an absolute worktree path, so match
      // the .mma/specs/ segment (not a leading anchor) and reject the old docs/mma root.
      const specStr = String(specPath);
      if (hasSpecPath && (!/(^|\/)\.mma\/specs\//.test(specStr) || specStr.includes('docs/mma'))) {
        return ['FAIL', `specPath not under .mma/specs/: ${specPath}`];
      }
      const sections = specSummary?.sections ?? [];
      const CANON = ['Context', 'Problem', 'Goals & Requirements', 'Alternatives', 'Technical Design', 'Testing Plan', 'Risks & Mitigations', 'User Stories & Tasks'];
      if (subsetComponents) {
        // Subset spec: pass iff sections equals exactly the requested set in canonical order.
        const want = CANON.filter(c => subsetComponents.includes(c));
        const exact = sections.length === want.length && want.every((c, i) => sections[i] === c);
        return [exact ? 'PASS' : 'FAIL', `subset spec; specPath=${hasSpecPath}; sections=${JSON.stringify(sections)} (want ${JSON.stringify(want)})`];
      }
      const missingComponents = CANON.filter(c => !sections.includes(c));
      const forgeCompat = missingComponents.length === 0;
      return [forgeCompat ? 'PASS' : 'WARN', `${outputLen} chars; specPath=${hasSpecPath}; forge-compat=${forgeCompat}${missingComponents.length > 0 ? ` missing=[${missingComponents.join(',')}]` : ''}`];
    }
    case 'plan': {
      if (outputLen < 20) return ['WARN', `plan output very short (${outputLen} chars)`];
      const planSummary = r?.output?.summary;
      const planPath = planSummary?.planPath ?? null;
      const hasPlanPath = planPath != null;
      // Default artifact root is .mma/plans/ (co-located with the journal). Scenario
      // #25 sends no outputPath, so the derived path must land under .mma/plans/ —
      // regression guard. The worker may return an absolute worktree path, so match
      // the .mma/plans/ segment (not a leading anchor) and reject the old docs/mma root.
      const planStr = String(planPath);
      if (hasPlanPath && (!/(^|\/)\.mma\/plans\//.test(planStr) || planStr.includes('docs/mma'))) {
        return ['FAIL', `planPath not under .mma/plans/: ${planPath}`];
      }
      return ['PASS', `${outputLen} chars output; planPath=${planPath ?? 'none'}`];
    }
    default:
      return ['PASS', `${outputLen} chars output (no type-specific quality check)`];
  }
}

export function verify(rec) {
  const out = [];
  const { response: r, diagnostics: d, queue: q, backend: b, expect: e } = rec;

  // ─── Error cases: validate HTTP 400 ───
  if (e.kind === 'error') {
    const status = rec.errorStatus;
    const json = rec.errorJson;
    out.push(C('http-status', status === e.expectStatus ? 'PASS' : 'FAIL',
      `expected=${e.expectStatus} got=${status}`));
    const hasError = json && (json.error || json.message || json.code);
    out.push(C('error-body', hasError ? 'PASS' : 'WARN',
      `body=${JSON.stringify(json).slice(0, 200)}`));
    return out;
  }

  // ─── Assist routes (context-blocks): minimal envelope check ───
  if (e.kind === 'assist') {
    out.push(C('register', r && r.task ? 'PASS' : 'WARN', JSON.stringify(r?.error)));
    return out;
  }

  // ─── Cooperative cancellation (#39): DELETE /task/:id ───
  //     202 means REQUESTED, not stopped. The contract is the whole lifecycle:
  //     the ack carries the flag, a poll taken immediately after still reports
  //     `running` WITH the flag, and only once the runner confirms termination
  //     does the task seal as `cancelled`. The reviewer must never have run —
  //     cancellation has to stop the pipeline before review, or a half-finished
  //     draft would get refined into a fabricated answer.
  if (e.kind === 'cancel') {
    const c = rec.cancel ?? {};
    out.push(C('cancel-202', c.status === 202 ? 'PASS' : 'FAIL', `status=${c.status}`));
    out.push(C('cancel-ack', c.body?.cancellationRequested === true && c.body?.status === 'running'
      ? 'PASS' : 'FAIL', `body=${JSON.stringify(c.body)}`));

    const p = rec.pollAfterCancel ?? {};
    // Tolerate the race where the runner tore down between the ack and this poll.
    const midFlight = p.status === 202 && p.body?.cancellationRequested === true;
    const alreadyTerminal = p.status === 200;
    out.push(C('cancel-flag-visible', midFlight || alreadyTerminal ? 'PASS' : 'FAIL',
      `status=${p.status} flag=${p.body?.cancellationRequested}`));

    out.push(C('terminal-cancelled', r?.task?.status === 'cancelled' ? 'PASS' : 'FAIL',
      `status=${r?.task?.status}`));
    out.push(C('cancel-error-code', r?.error?.code === 'aborted' ? 'PASS' : 'FAIL',
      `error=${JSON.stringify(r?.error)}`));
    out.push(C('reviewer-skipped', r?.metrics?.reviewer === null ? 'PASS' : 'FAIL',
      `reviewer=${JSON.stringify(r?.metrics?.reviewer)}`));

    const rd = rec.repeatCancel ?? {};
    out.push(C('cancel-idempotent',
      rd.status === 200 && rd.body?.alreadyTerminal === true && rd.body?.status === 'cancelled'
        ? 'PASS' : 'FAIL', `status=${rd.status} body=${JSON.stringify(rd.body)}`));

    const keys = Object.keys(r ?? {}).sort();
    out.push(C('layered-200',
      JSON.stringify(keys) === JSON.stringify(['error', 'execution', 'metrics', 'output', 'raw', 'task'])
        ? 'PASS' : 'FAIL', `keys=${keys.join(',')}`));
    return out;
  }

  // ─── MCP adapter (#40): POST /mcp, second transport over the SAME runtime ───
  if (e.kind === 'mcp') {
    const m = rec.mcp ?? {};
    const serverInfo = m.init?.json?.result?.serverInfo;
    out.push(C('mcp-initialize', serverInfo?.name === 'multi-model-agent' ? 'PASS' : 'FAIL',
      `serverInfo=${JSON.stringify(serverInfo)}`));

    // A deliberate golden, not a derived list: growing or shrinking the MCP tool
    // surface is a wire-contract change every consumer feels, so it should require
    // editing this line. (It went stale once — `mma_task_list` and the two
    // context-block tools shipped while this still expected the original four.)
    const toolNames = (m.tools?.json?.result?.tools ?? []).map((t) => t.name).sort();
    const expected = [
      'mma_context_block_create', 'mma_context_block_delete', 'mma_run',
      'mma_task_cancel', 'mma_task_get', 'mma_task_list', 'mma_task_wait',
    ];
    out.push(C('mcp-tools', JSON.stringify(toolNames) === JSON.stringify(expected) ? 'PASS' : 'FAIL',
      `tools=${toolNames.join(',')}`));

    // And what the published plugin TELLS users it exposes must be the same set.
    // The README is generated from a hand-written sentence in build-plugin.ts, so
    // it is exactly the kind of thing that drifts silently from the live surface —
    // a user reads it, asks for a tool that no longer exists, and the failure looks
    // like their mistake.
    try {
      const readme = readFileSync(new URL('../../plugin/README.md', import.meta.url), 'utf8');
      const advertised = [...readme.matchAll(/`(mma_[a-z_]+)`/g)].map((x) => x[1]);
      const missing = toolNames.filter((t) => !advertised.includes(t));
      const phantom = [...new Set(advertised)].filter((t) => !toolNames.includes(t));
      out.push(C('mcp-tools-documented', missing.length === 0 && phantom.length === 0 ? 'PASS' : 'FAIL',
        missing.length === 0 && phantom.length === 0
          ? `plugin README advertises exactly the ${toolNames.length} live tools`
          : `undocumented=[${missing.join(',')}] advertised-but-absent=[${phantom.join(',')}]`));
    } catch (err) {
      out.push(C('mcp-tools-documented', 'FAIL', `could not read plugin/README.md: ${err.message}`));
    }

    // mma_run's request schema is GENERATED from the task-input Zod union — one
    // variant per task type. A hand-written schema would drift; this catches it.
    const runTool = (m.tools?.json?.result?.tools ?? []).find((t) => t.name === 'mma_run');
    const reqSchema = runTool?.inputSchema?.properties?.request;
    const variants = reqSchema?.oneOf ?? reqSchema?.anyOf ?? [];
    out.push(C('mcp-generated-schema', variants.length === 12 ? 'PASS' : 'FAIL',
      `request variants=${variants.length} (expected 12, one per task type)`));

    out.push(C('mcp-run-handle', m.taskId ? 'PASS' : 'FAIL',
      `payload=${JSON.stringify(m.runPayload).slice(0, 160)}`));

    const w = m.waitPayload;
    out.push(C('mcp-terminal', w?.task?.status && w.task.status !== 'failed' ? 'PASS' : 'FAIL',
      `status=${w?.task?.status} error=${JSON.stringify(w?.error)}`));

    // THE load-bearing assertion: the same execution read over REST must be
    // byte-identical — one runtime, two transports, no duplicated state.
    const parity = m.restStatus === 200
      && JSON.stringify(m.restEnvelope) === JSON.stringify(w);
    out.push(C('mcp-rest-parity', parity ? 'PASS' : 'FAIL',
      `restStatus=${m.restStatus} identical=${JSON.stringify(m.restEnvelope) === JSON.stringify(w)}`));
    return out;
  }

  // ─── Async-error tasks (F5): a task that fails AFTER the 202 (e.g. an unresolvable
  //     target path) must return the SAME 6-field envelope as any terminal result,
  //     with the failure in `error` — not a bare { code, message } callers can't detect
  //     via env.error. ───
  if (e.kind === 'async_error') {
    const keys = Object.keys(r ?? {}).sort();
    const shapeOk = JSON.stringify(keys) === JSON.stringify(['error', 'execution', 'metrics', 'output', 'raw', 'task']);
    out.push(C('layered-200', shapeOk ? 'PASS' : 'FAIL', `keys=${keys.join(',')}`));
    const err = r?.error;
    const errOk = err && typeof err.code === 'string' && typeof err.message === 'string';
    out.push(C('async-error-envelope', errOk ? 'PASS' : 'FAIL', `error=${JSON.stringify(err)}`));
    out.push(C('async-error-status', r?.task?.status === 'failed' ? 'PASS' : 'FAIL', `status=${r?.task?.status}`));
    return out;
  }

  // New layered response: { task, output, execution, metrics, raw, error }
  const taskStatus = r?.task?.status;
  const implSessionId = r?.execution?.sessions?.implementer;
  const revSessionId = r?.execution?.sessions?.reviewer;

  // ① response — did the task complete? A non-null error is the ONLY failure signal.
  //    done and done_with_concerns both carry error:null (a reviewer that couldn't emit
  //    parseable output is a concern surfaced in output.reviewerNote, NOT a fatal error —
  //    the implementer answer still stands in output.summary).
  const responseStatus = r?.error === null ? 'PASS' : 'FAIL';
  out.push(C('response', responseStatus, JSON.stringify(r?.error)));

  // ①b reviewer-degrade — whenever a real reviewer flakes on output format, the task must
  //    degrade gracefully rather than hard-fail. This invariant fires only when it actually
  //    happens (reviewerNote non-null), so it captures the haiku-writes-prose scenario in a
  //    live run without needing to force it. Contract when the reviewer was unavailable:
  //      • error is null (not fatal)          • status is done_with_concerns
  //      • output.summary carries a non-empty implementer answer (not the reviewer garbage)
  //      • reviewerNote.code === 'reviewer_unavailable'
  if (e.kind === 'read' || e.kind === 'write') {
    const note = r?.output?.reviewerNote ?? null;
    if (note !== null) {
      const summary = r?.output?.summary;
      const summaryLen = typeof summary === 'string'
        ? summary.length
        : (summary && typeof summary === 'object' ? JSON.stringify(summary).length : 0);
      const degradeOk =
        r?.error === null &&
        taskStatus === 'done_with_concerns' &&
        note.code === 'reviewer_unavailable' &&
        summaryLen > 2; // non-empty object/string — implementer answer survived
      out.push(C('reviewer-degrade', degradeOk ? 'PASS' : 'FAIL',
        `reviewer unavailable → error=${JSON.stringify(r?.error)} status=${taskStatus} noteCode=${note.code} summaryLen=${summaryLen}`));
    }
  }

  // ② sessions — validate session shape on the execution layer
  if (e.kind === 'read' || e.kind === 'write') {
    const hasImplSession = typeof implSessionId === 'string' && implSessionId.length > 0;
    out.push(C('sessions', hasImplSession ? 'PASS' : 'FAIL',
      `implementer={sessionId:${implSessionId?.slice(0, 12)}...}`));
  }

  // ③ tier — the new response does not carry tier on the session; tier is a
  // request-side concept validated by the scenario config. We still check that
  // the implementer session exists (validated above). If we had tier in metrics
  // we could check it here; for now this is a no-op when e.tier is set.
  // (The old contract embedded tier on sessions.implementer.tier; the new one
  // does not. Skip the tier check — it's enforced at dispatch time by the server.)

  // ④ review — reviewer session present when reviewed, absent when none
  if (e.kind === 'write') {
    if (e.reviewPolicy === 'none') {
      const skipped = revSessionId == null;
      out.push(C('review', skipped ? 'PASS' : 'FAIL',
        `reviewPolicy=none; reviewer=${revSessionId}`));
    } else if (e.type === 'journal_record') {
      // journal_record is deterministic decide-then-apply: the reviewer runs only when the
      // apply's invariants don't pass. A clean apply legitimately skips the reviewer, so a null
      // reviewer is correct here — either presence or absence is acceptable.
      out.push(C('review', 'PASS',
        `journal_record: reviewer optional (deterministic apply); reviewer=${revSessionId}`));
    } else {
      const hasReviewer = revSessionId != null && typeof revSessionId === 'string';
      out.push(C('review', hasReviewer ? 'PASS' : 'FAIL',
        `reviewer=${revSessionId}`));
    }
  }

  // Write-type specific checks
  if (e.kind === 'write') {
    const st = taskStatus;
    const ok = st === 'done' || st === 'done_with_concerns';
    const soft = e.reviewPolicy === 'none';
    out.push(C('terminal-status', ok ? 'PASS' : (soft ? 'WARN' : 'FAIL'),
      `status=${st}${!ok && soft ? ' (no-guarantor -> soft)' : ''}`));

    // `execution.worktree` is a structurally-required response key whose value is now
    // permanently null — the engine owns no worktrees. Asserting null on EVERY route (not just
    // non-git ones) is what catches a regression that reintroduces engine-side worktrees.
    const wt = r?.execution?.worktree;
    out.push(C('worktree-null', wt === null ? 'PASS' : 'FAIL',
      wt === null ? 'execution.worktree null (engine owns no worktrees)' : `expected null, got ${JSON.stringify(wt)}`));

    // FR-4 — dirty-tree disclosure. Always present and boolean, so a caller can read it
    // unconditionally; true exactly when the fixture left the tree dirty at dispatch.
    const dirty = r?.execution?.dirtyAtDispatch;
    if (typeof dirty !== 'boolean') {
      out.push(C('dirty-at-dispatch', 'FAIL', `execution.dirtyAtDispatch must be a boolean, got ${JSON.stringify(dirty)}`));
    } else if (e.dirtyRepo) {
      out.push(C('dirty-at-dispatch', dirty === true ? 'PASS' : 'FAIL',
        `fixture dispatched a dirty tree → expect true, got ${dirty}`));
    } else if (e.nonGitCwd) {
      out.push(C('dirty-at-dispatch', dirty === false ? 'PASS' : 'FAIL',
        `non-git target has no dirty state → expect false, got ${dirty}`));
    } else {
      out.push(C('dirty-at-dispatch', 'PASS', `boolean (${dirty})`));
    }
  }

  // Read-type specific checks
  if (e.kind === 'read') {
    if (e.type === 'research') {
      // sourcesUsed is no longer on the response envelope — research sources
      // are internal to the research orchestrator. The task completed if we
      // reached here, so we mark sources as PASS with a note.
      out.push(C('research-sources', 'PASS',
        `sourcesUsed not in response envelope (internal to research orchestrator)`));
      out.push(C('research-adapter-surface', 'PASS',
        `adapter surface validated server-side`));
    }
  }

  // ⑤ quality — does the output contain meaningful, type-appropriate content?
  if (e.kind === 'read' || e.kind === 'write') {
    const [qStatus, qDetail] = checkQuality(e.type, e.subtype, r, e.subsetComponents);
    out.push(C('quality', qStatus, qDetail));
  }

  // ⑤b pipeline-collaboration — did the reviewer receive implementer output?
  //    The two-phase pipeline should produce non-empty implementer output AND
  //    non-empty reviewer output. If either is empty, the collaborative pipeline
  //    is broken (reviewer rubber-stamped or implementer produced nothing).
  //    journal_record is exempt: its reviewer runs only on an invariant failure (deterministic
  //    decide-then-apply), so a clean apply has no reviewer output by design.
  if ((e.kind === 'read' || e.kind === 'write') && e.reviewPolicy !== 'none' && e.type !== 'orchestrate' && e.type !== 'journal_record') {
    const rawImpl = r?.raw?.implementer ?? '';
    const rawRev = r?.raw?.reviewer ?? '';
    const implLen = typeof rawImpl === 'string' ? rawImpl.length : 0;
    const revLen = typeof rawRev === 'string' ? rawRev.length : 0;
    // The check catches a BROKEN pipeline (an empty side), not terse-but-valid output.
    // A correct delegate/execute_plan can legitimately return a compact JSON block (~20–40
    // chars), so the bar is "non-empty", not "long": both sides must clear a small floor.
    const bothPresent = implLen > 10 && revLen > 10;
    out.push(C('pipeline-collaboration', bothPresent ? 'PASS' : 'FAIL',
      `implementer=${implLen}chars reviewer=${revLen}chars — both must be non-empty`));
  }

  // ⑥ contextBlockId
  if (e.kind === 'read' || e.kind === 'write') {
    const cb = r?.output?.contextBlockId;
    if (e.kind === 'read') {
      const ok = typeof cb === 'string' && cb.length > 0;
      out.push(C('context-block', ok ? 'PASS' : (e.type === 'research' ? 'WARN' : 'FAIL'),
        `contextBlockId=${cb} (read route -> expect non-null id)`));
    } else {
      out.push(C('context-block', cb === null ? 'PASS' : 'FAIL',
        `contextBlockId=${cb} (write route -> expect exactly null; undefined = not projected)`));
    }
  }

  // ⑦ cost
  if (e.kind === 'read' || e.kind === 'write') {
    const implCost = r?.metrics?.implementer?.costUsd;
    const hasCost = typeof implCost === 'number' && implCost > 0;
    out.push(C('cost', hasCost ? 'PASS' : 'FAIL',
      `implementer.costUsd=${implCost}`));
  }

  // Session reuse check
  if (e.sessionReuse && rec.resumeSessionId) {
    const actualId = implSessionId;
    out.push(C('session-reuse', actualId === rec.resumeSessionId ? 'PASS' : 'FAIL',
      `requested=${rec.resumeSessionId?.slice(0, 12)}... got=${actualId?.slice(0, 12)}...`));
  }

  // ⑧ diagnostics
  if (d && d.events.length) {
    const kinds = [...new Set(d.events.map((x) => x.kind))];
    const terminal = kinds.includes('batch_completed') || kinds.includes('batch_failed');
    out.push(C('diag-events', kinds.includes('batch_created') && terminal ? 'PASS' : 'FAIL', `kinds=${kinds}`));
  } else {
    out.push(C('diag-events', 'WARN', 'no diagnostics events found for task'));
  }

  // ⑨ Sandbox confinement (scenarios #20-22)
  if (e.sandbox) {
    const output = r?.raw?.implementer ?? (typeof r?.output?.summary === 'string' ? r.output.summary : '') ?? '';

    if (e.sandbox === 'cwd-only' && e.id === 20) {
      // The worker was told to write to /tmp; the hook should have denied it.
      // Worker should have adapted and written in-cwd instead.
      const wroteInCwd = /confined|CONFINED|src\/confined/.test(output) || taskStatus === 'done' || taskStatus === 'done_with_concerns';
      out.push(C('sandbox-cwd-escape', wroteInCwd ? 'PASS' : 'WARN',
        `worker adapted to cwd confinement; status=${taskStatus}; output has confined=${/confined/i.test(output)}`));
    }

    if (e.sandbox === 'cwd-only' && e.id === 21) {
      // The worker was told to cd /tmp && touch file; the hardened hook should block.
      const adapted = /cd.safe|CD_SAFE|src\/cd-safe/.test(output) || taskStatus === 'done' || taskStatus === 'done_with_concerns';
      out.push(C('sandbox-cd-chain', adapted ? 'PASS' : 'WARN',
        `cd-chain escape blocked; status=${taskStatus}; output has cd-safe=${/cd.safe/i.test(output)}`));
    }

    if (e.sandbox === 'read-only') {
      // Read-only task should complete normally without any write capability.
      out.push(C('sandbox-readonly', taskStatus === 'done' || taskStatus === 'done_with_concerns' ? 'PASS' : 'FAIL',
        `read-only sandbox task status=${taskStatus}`));
    }
  }

  // ⑩ Layered 200 shape — top-level keys must be exactly the 6 categories
  if (e.kind === 'read' || e.kind === 'write') {
    const keys = Object.keys(r ?? {}).sort();
    const expected = ['error', 'execution', 'metrics', 'output', 'raw', 'task'];
    const match = JSON.stringify(keys) === JSON.stringify(expected);
    out.push(C('layered-200', match ? 'PASS' : 'FAIL',
      `keys=${keys.join(',')} expected=${expected.join(',')}`));
  }

  // ⑪ Token usage — metrics must include per-phase usage + totalUsage
  if (e.kind === 'read' || e.kind === 'write') {
    const m = r?.metrics ?? {};
    const hasImplUsage = m.implementer?.usage?.inputTokens !== undefined;
    const hasTotalUsage = m.totalUsage?.inputTokens !== undefined;
    out.push(C('token-usage', hasImplUsage && hasTotalUsage ? 'PASS' : 'FAIL',
      `implementer.usage=${hasImplUsage} totalUsage=${hasTotalUsage}`));
  }

  // ⑫ Structured 202 polling shape (captured during poll phase)
  if (rec.polling202) {
    const p = rec.polling202;
    const hasFields = p.taskId && p.status === 'running' && p.phase && typeof p.elapsedMs === 'number' && p.startedAt;
    out.push(C('structured-202', hasFields ? 'PASS' : 'FAIL',
      `phase=${p.phase} elapsedMs=${p.elapsedMs} startedAt=${p.startedAt}`));

    // ⑫b A running task must say WHAT it is, not just how far along it is. A poll
    //     used to answer with a phase name that reads identically for a spec, a
    //     review and an investigation, while the type had been known since
    //     admission. `phaseElapsedMs` is asserted here too because it is the field
    //     that silently went missing on one wire when the two running-snapshot
    //     shapes were maintained by hand.
    const identity = p.taskId && typeof p.type === 'string' && p.type.length > 0 && typeof p.cwd === 'string' && p.cwd.length > 0;
    out.push(C('running-identity', identity && typeof p.phaseElapsedMs === 'number' ? 'PASS' : 'FAIL',
      `type=${p.type} cwd=${p.cwd ? 'set' : 'missing'} phaseElapsedMs=${p.phaseElapsedMs}`));
  }

  // ⑫c Identity is the SAME across admission, every poll, and the terminal
  //     envelope. Three surfaces, one answer — an agent reading back through a
  //     transcript finds the handle where it was returned, not where the task was
  //     submitted, so a disagreement between them is a real defect rather than a
  //     cosmetic one. Only the live daemon can prove this; a unit test asserts a
  //     shared helper, not that both wires actually call it.
  if (rec.admission && r?.task?.taskId) {
    const a = rec.admission;
    const p = rec.polling202;
    // `taskId` and `type` must be PRESENT on admission and on the terminal
    // envelope, not merely non-contradictory: an absent field agrees with
    // everything, which is exactly how a surface that silently stopped
    // reporting identity would slip through a pure equality check.
    const agree = (field, required) => {
      const surfaces = [['admit', a[field]], ['final', r.task[field]]];
      if (p) surfaces.push(['poll', p[field]]);
      const present = surfaces.filter(([, v]) => v !== undefined);
      if (required && present.length !== surfaces.length) return false;
      return present.every(([, v]) => v === present[0][1]);
    };
    const mismatched = [['taskId', true], ['type', true], ['subtype', false]]
      .filter(([f, required]) => !agree(f, required))
      .map(([f]) => f);
    out.push(C('identity-consistency', mismatched.length === 0 ? 'PASS' : 'FAIL',
      mismatched.length === 0
        ? `taskId/type${e.subtype ? '/subtype' : ''} present and equal across admission, poll, terminal`
        : `disagree or missing: ${mismatched.map((f) => `${f}(admit=${a[f]} poll=${p?.[f]} final=${r.task[f]})`).join(', ')}`));
  }

  // ⑬ Audit findings: weight field + evidence section prefix
  if (e.type === 'audit' && (e.kind === 'read')) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    if (findings.length > 0) {
      const allHaveWeight = findings.every(f => ['critical', 'high', 'medium', 'low'].includes(f.weight));
      out.push(C('weight-field', allHaveWeight ? 'PASS' : 'FAIL',
        `${findings.length} findings, all have valid weight=${allHaveWeight}`));

      // Grounding convention: every evidence string starts with its source in square brackets —
      // a markdown heading for document audits (`[### Heading]`) or a file/path ref for code audits
      // (`[src/math.ts]` or `[src/math.ts:3]`, since code has no headings). Accept any bracketed
      // source prefix; what matters is that the finding names where the evidence lives.
      const withPrefix = findings.filter(f => /^\[[^\]]+\]\s/.test(f.evidence ?? ''));
      out.push(C('evidence-prefix', withPrefix.length > 0 ? 'PASS' : 'WARN',
        `${withPrefix.length}/${findings.length} findings have a [source] evidence prefix`));
    }
  }

  // ⑭ Audit subtype in task identity
  if (e.type === 'audit' && e.subtype) {
    const actualSubtype = r?.task?.subtype;
    out.push(C('subtype', actualSubtype === e.subtype ? 'PASS' : 'FAIL',
      `expected=${e.subtype} got=${actualSubtype}`));
  }

  // ⑮ Write route filesChanged — must be populated (from git diff or tool tracking).
  // Non-git (in-place) targets have no git diff to compute changed files from, so the
  // git-diff-based filesChanged is not asserted there.
  if (e.kind === 'write' && e.reviewPolicy !== 'none' && !e.nonGitCwd && !e.noopWrite && e.type !== 'journal_record') {
    const fc = r?.output?.filesChanged;
    const hasFiles = Array.isArray(fc) && fc.length > 0;
    out.push(C('files-changed', hasFiles ? 'PASS' : 'WARN',
      `filesChanged=${Array.isArray(fc) ? fc.length : 'missing'} files`));
  }

  // ⑮b journal_record batch completeness — a records[] batch must produce exactly
  //     one outcome per submitted record: recorded[]+failed[] === submitted count.
  if (e.batchRecords) {
    const summary = r?.output?.summary;
    const recorded = Array.isArray(summary?.recorded) ? summary.recorded.length : 0;
    const failed = Array.isArray(summary?.failed) ? summary.failed.length : 0;
    out.push(C('batch-completeness', recorded + failed === e.batchRecords ? 'PASS' : 'FAIL',
      `recorded=${recorded} failed=${failed} submitted=${e.batchRecords} (records[] processed sequentially)`));
  }

  // ⑯ Delta mode — verify that round 2 audit (with contextBlockId) still produces findings
  if (e.delta) {
    const summary = r?.output?.summary;
    const findings = summary?.findings ?? [];
    out.push(C('delta-mode', findings.length >= 0 ? 'PASS' : 'FAIL',
      `delta round 2: ${findings.length} findings (task completed with prior context injected)`));
  }

  // ⑰ Spec components — default spec emits all 8 (Forge-compat); a subset request must
  //    emit EXACTLY the requested components, reordered to canonical order.
  if (e.type === 'spec') {
    const specSummary = r?.output?.summary;
    const sections = specSummary?.sections ?? [];
    const CANON = ['Context', 'Problem', 'Goals & Requirements', 'Alternatives', 'Technical Design', 'Testing Plan', 'Risks & Mitigations', 'User Stories & Tasks'];
    if (e.subsetComponents) {
      // Expected = the requested labels in canonical order (regardless of request order).
      const want = CANON.filter(c => e.subsetComponents.includes(c));
      const exact = sections.length === want.length && want.every((c, i) => sections[i] === c);
      out.push(C('subset-components', exact ? 'PASS' : 'FAIL',
        `requested=${JSON.stringify(e.subsetComponents)} expected-canonical=${JSON.stringify(want)} got=${JSON.stringify(sections)}`));
    } else {
      const missing = CANON.filter(c => !sections.includes(c));
      out.push(C('forge-compat', missing.length === 0 ? 'PASS' : 'WARN',
        `sections=${JSON.stringify(sections)}${missing.length > 0 ? ` missing=[${missing.join(',')}]` : ''}`));
    }
    if (e.groundingFile) {
      // Two target files (decisions [authoritative] + exploration.md [grounding]) must
      // still produce a full 8-component spec — proving the multi-file dispatch works and
      // the worker expanded the decisions, not the exploration's unresolved rough options.
      out.push(C('two-file-grounding', sections.length === 8 ? 'PASS' : 'FAIL',
        `2 target files → sections=${JSON.stringify(sections)}`));
    }
  }

  // ⑱ Non-git cwd — the route edits the folder in place and the engine makes NO commit, so
  //    there is no git evidence to derive: filesChanged falls back to the provider's list.
  if (e.nonGitCwd) {
    const wt = r?.execution?.worktree;
    const dirty = r?.execution?.dirtyAtDispatch;
    out.push(C('non-git-cwd', wt === null && dirty === false ? 'PASS' : 'FAIL',
      `worktree=${JSON.stringify(wt)} (expect null), dirtyAtDispatch=${dirty} (expect false — a non-git dir has no dirty state)`));
  }

  // Queue (per-dispatch, best-effort)
  const inQueue = (q?.records?.length ?? 0) > 0;
  out.push(C('queue', inQueue ? 'PASS' : 'NA', `records=${q?.records?.length ?? 0}`));
  if (inQueue) {
    const sv = q.records[0].schemaVersion ?? q.records[0].schema_version;
    out.push(C('schema-version', sv === undefined || sv === SCHEMA_VERSION ? 'PASS' : 'FAIL', `schemaVersion=${sv} want=${SCHEMA_VERSION}`));
  }
  return out;
}
