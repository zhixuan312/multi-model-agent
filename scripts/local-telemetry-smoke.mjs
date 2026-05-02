#!/usr/bin/env node
// Local 3.10.1 telemetry smoke — builds a V3 task.completed event from the
// local source tree using the real `buildTaskCompletedEvent` so the values
// match what production-mma will emit, then POSTs it to a backend you point
// at via BACKEND_URL.
//
// Usage:
//   BACKEND_URL=http://localhost:8088 node scripts/local-telemetry-smoke.mjs
//
// Prerequisites:
//   - npm run build (so dist/ exists)
//   - backend running with migrations applied at $BACKEND_URL

import { randomUUID } from 'node:crypto';
import { buildTaskCompletedEvent } from '../packages/core/dist/telemetry/event-builder.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';

// A realistic RunResult that exercises every V3 stage variant.
const runResult = {
  output: 'Task completed successfully.',
  status: 'ok',
  usage: {
    inputTokens: 12_000,
    outputTokens: 3_400,
    totalTokens: 15_400,
    cachedTokens: 8_000,
    reasoningTokens: 0,
    costUSD: 0.0234,
  },
  turns: 8,
  filesRead: ['src/foo.ts', 'src/bar.ts', 'README.md'],
  filesWritten: ['src/foo.ts'],
  toolCalls: ['Read', 'Read', 'Edit', 'Read', 'Bash', 'Read', 'Edit', 'Read', 'Edit', 'Read', 'Bash', 'Edit'],
  durationMs: 45_000,
  models: { implementer: 'claude-sonnet-4-6' },
  agents: { implementer: 'standard', implementerToolMode: 'full', implementerCapabilities: [] },
  terminationReason: 'finished',
  concerns: [
    { source: 'spec_review', severity: 'medium', message: 'Edge case missing' },
  ],
  taskMaxIdleMs: 1_200,
  stallTriggered: false,
  stallCount: 0,
  briefQualityWarnings: [],
  stageStats: {
    implementing: {
      stage: 'implementing', entered: true,
      durationMs: 30_000, costUSD: 0.0156,
      agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet-4-6',
      maxIdleMs: 800, totalIdleMs: 1_600, activityEvents: 14,
      inputTokens: 9_000, outputTokens: 2_400, cachedTokens: 6_000, reasoningTokens: 0,
      turnCount: 6, toolCallCount: 12, filesReadCount: 3, filesWrittenCount: 1,
    },
    spec_review: {
      stage: 'spec_review', entered: true,
      durationMs: 8_000, costUSD: 0.0052,
      agentTier: 'reasoning', modelFamily: 'claude', model: 'claude-opus-4-7',
      maxIdleMs: 0, totalIdleMs: 0, activityEvents: 1,
      inputTokens: 2_000, outputTokens: 600, cachedTokens: 1_500, reasoningTokens: 0,
      turnCount: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
      verdict: 'concerns', roundsUsed: 1,
    },
    quality_review: {
      stage: 'quality_review', entered: true,
      durationMs: 7_000, costUSD: 0.0026,
      agentTier: 'reasoning', modelFamily: 'claude', model: 'claude-opus-4-7',
      maxIdleMs: 0, totalIdleMs: 0, activityEvents: 1,
      inputTokens: 1_000, outputTokens: 400, cachedTokens: 500, reasoningTokens: 0,
      turnCount: 1, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 0,
      verdict: 'approved', roundsUsed: 1,
    },
    spec_rework: { stage: 'spec_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: null, totalIdleMs: null, activityEvents: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null },
    quality_rework: { stage: 'quality_rework', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: null, totalIdleMs: null, activityEvents: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null },
    diff_review: { stage: 'diff_review', entered: false, durationMs: null, costUSD: null, agentTier: null, modelFamily: null, model: null, maxIdleMs: null, totalIdleMs: null, activityEvents: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null, verdict: null, roundsUsed: null },
    verifying: {
      stage: 'verifying', entered: true,
      durationMs: 0, costUSD: 0,
      agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet-4-6',
      maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0,
      inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null,
      turnCount: null, toolCallCount: null, filesReadCount: null, filesWrittenCount: null,
      outcome: 'skipped', skipReason: 'no_command',
    },
    committing: {
      stage: 'committing', entered: true,
      durationMs: 200, costUSD: 0,
      agentTier: 'standard', modelFamily: 'claude', model: 'claude-sonnet-4-6',
      maxIdleMs: 0, totalIdleMs: 0, activityEvents: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0,
      turnCount: 0, toolCallCount: 0, filesReadCount: 0, filesWrittenCount: 1,
    },
  },
};

const event = buildTaskCompletedEvent({
  route: 'delegate',
  taskSpec: { filePaths: ['src/foo.ts'] },
  runResult,
  client: 'claude-code',
  parentModel: 'claude-opus-4-7',
});

console.log('Built V3 event — top-level totals (these were 0 in 3.10.0):');
console.log({
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  cachedTokens: event.cachedTokens,
  reasoningTokens: event.reasoningTokens,
  totalCostUSD: event.totalCostUSD,
  costDeltaVsParentUSD: event.costDeltaVsParentUSD,
});
console.log('\nPer-stage implementing tokens (these were 0 in 3.10.0):');
const impl = event.stages.find(s => s.name === 'implementing');
console.log({
  inputTokens: impl?.inputTokens,
  outputTokens: impl?.outputTokens,
  turnCount: impl?.turnCount,
  toolCallCount: impl?.toolCallCount,
  filesReadCount: impl?.filesReadCount,
  filesWrittenCount: impl?.filesWrittenCount,
  costUSD: impl?.costUSD,
});

const batch = {
  schemaVersion: 3,
  installId: '11111111-1111-1111-1111-111111111111',
  mmagentVersion: '3.10.1',
  os: 'darwin',
  nodeMajor: 22,
  events: [event],
};

const res = await fetch(`${BACKEND_URL}/v1/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(batch),
});
console.log(`\nPOST ${BACKEND_URL}/v1/events → ${res.status}`);
if (res.status !== 204) {
  console.error('Body:', await res.text());
  process.exit(1);
}

const proofs = await fetch(`${BACKEND_URL}/api/dashboard/p1/proofs?period=7d`).then(r => r.json());
console.log('\nDashboard /p1/proofs:');
console.log(proofs);

console.log('\n✓ Local 3.10.1 telemetry smoke passed. Open the frontend at http://localhost:5173 to see the dashboard.');
