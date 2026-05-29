// tests/cli/serve-recorder-init-order.test.ts
//
// Regression test for the 4.7.3 telemetry-init-order bug:
//
//   server.ts builds a TelemetryUploader and wires it to the bus DURING
//   startServer(). The uploader calls getRecorder() at construction time
//   to capture a Recorder reference. If createRecorder() hasn't run yet,
//   getRecorder() throws, server.ts silently catches and wires the
//   uploader with recorder=null — and then SILENTLY DROPS every telemetry
//   event for the daemon's lifetime.
//
// This test pins the invocation order: createRecorder must appear before
// startServer in serve.ts. A future refactor that swaps these lines (or
// removes the explicit createRecorder call) will fail this test instead
// of silently breaking telemetry in production.
//
// Why a source-text test instead of a behavioral one: behavioral coverage
// here means booting startServe() with mocked deps, which pulls in
// hundreds of lines of CLI/config/registry wiring just to observe one
// init-order property. Source-text inspection is the minimum-cost,
// maximum-precision check for this specific failure mode.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_PATH = join(__dirname, '..', '..', 'packages', 'server', 'src', 'cli', 'serve.ts');

describe('serve.ts — telemetry recorder init order', () => {
  it('calls createRecorder BEFORE startServer (regression: TelemetryUploader was wired with recorder=null)', () => {
    const src = readFileSync(SERVE_PATH, 'utf8');

    // Strip block/line comments before scanning so doc-comment mentions
    // of either function name don't confuse the order check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');

    // Use `await startServer(` and `createRecorder(` — the runtime call
    // forms — so we match invocation sites rather than `import {…}` lines.
    const startServerIdx = code.indexOf('startServer(');
    const createRecorderIdx = code.indexOf('createRecorder(');
    expect(startServerIdx).toBeGreaterThan(-1);
    expect(createRecorderIdx).toBeGreaterThan(-1);

    // createRecorder must appear earlier in the file than startServer.
    expect(createRecorderIdx).toBeLessThan(startServerIdx);
  });
});
