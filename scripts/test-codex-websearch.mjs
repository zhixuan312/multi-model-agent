#!/usr/bin/env node
// Verify which hosted web-search tool type the Codex backend accepts.
// Usage: CODEX_DEBUG=1 node scripts/test-codex-websearch.mjs
//
// Tests each candidate tool name in turn and prints the RunResult.
// If the backend rejects the shape, the wrapped fetch captures the
// raw 4xx body and the runner surfaces it in result.error.

import { runCodex } from '../dist/runners/codex-runner.js';

const CANDIDATES = ['web_search', 'web_search_preview'];

const prompt =
  'Use your web_search tool to find the current weather in Singapore. ' +
  'Report temperature and conditions. If you do not have a web search tool, say so explicitly.';

const defaults = { maxTurns: 4, timeoutMs: 60_000, tools: 'full' };

for (const tool of CANDIDATES) {
  console.log(`\n=========================================`);
  console.log(`[test] trying hostedTools: ["${tool}"]`);
  console.log(`=========================================`);

  const providerConfig = {
    type: 'codex',
    model: 'gpt-5.4',
    hostedTools: [tool], // bypass TS enum — runtime passthrough
  };

  try {
    const result = await runCodex(
      prompt,
      { tools: 'full' },
      providerConfig,
      defaults,
    );
    console.log(`[test] status: ${result.status}`);
    console.log(`[test] turns: ${result.turns}`);
    console.log(`[test] output: ${result.output}`);
    if (result.error) console.log(`[test] error: ${result.error}`);
  } catch (err) {
    console.log(`[test] THREW: ${err?.message ?? err}`);
  }
}
