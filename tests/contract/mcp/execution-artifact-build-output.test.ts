import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { __setExecutionArtifactOverrideForTests } from '../../../packages/server/src/mcp/execution-artifact.js';

/**
 * Proofs against the REAL built bundle (produced once by the global setup in
 * `tests/setup/build-execution-artifact.global-setup.ts`), not a synthetic page.
 *
 * Everything else in this suite exercises `entry.ts` as a module. That leaves one whole
 * class of failure uncovered: the bundle ships, but the shipped HTML is wrong — no mount
 * point, an un-inlined import, a placeholder served in place of the build. Those only
 * surface when the actual bytes are parsed and executed, which is what these tests do.
 *
 * This file runs in the DEFAULT node environment on purpose — do not add the jsdom
 * environment pragma. The `JSDOM` constructor is just an import and needs no ambient DOM,
 * whereas running the whole file under jsdom swaps in jsdom's `fetch`/`AbortSignal`, and the
 * MCP HTTP transport then fails its own instanceof check ("Expected signal to be an instance
 * of AbortSignal") — a realm mismatch, not a defect in anything under test.
 *
 * Note for anyone editing this comment: Vitest matches the environment pragma ANYWHERE in the
 * file, including inside prose. Spelling it out here — even to say "not this" — silently puts
 * the file back under jsdom and breaks the byte-parity test below. Hence the circumlocution.
 */
const artifactPath = resolve(process.cwd(), 'packages/server/dist/ui/execution.html');

describe('contract: built execution artifact (real bytes, real DOM)', () => {
  it('has no external <script src=>/<link href=> origins and is well over trivial size', () => {
    const html = readFileSync(artifactPath, 'utf8');
    expect(html.length).toBeGreaterThan(1_000);
    expect(html).not.toMatch(/<script[^>]+\bsrc=["']https?:\/\//i);
    expect(html).not.toMatch(/<link[^>]+\bhref=["']https?:\/\//i);
  });

  it('stays within its size budget', () => {
    // Everything is inlined into one file the host must fetch and parse, so the stage's art
    // has to earn its bytes. The ceiling is deliberately close to the current figure: it is a
    // ratchet, meant to make an accidental dependency import or an inlined raster obvious
    // immediately rather than after the bundle has quietly doubled.
    const bytes = readFileSync(artifactPath).length;
    expect(bytes, `execution.html is ${(bytes / 1024).toFixed(0)} KB`).toBeLessThan(420 * 1024);
  });

  it('ships the three-act stage, not just the old text panel', () => {
    // The scene is generated at runtime, but its stylesheet is part of the bundle — if the
    // stage CSS is missing the panel silently degrades to unstyled markup.
    const html = readFileSync(artifactPath, 'utf8');
    expect(html).toMatch(/mma-ua-strike/);
    expect(html).toMatch(/mma-ua-probe/);
    expect(html).toMatch(/prefers-reduced-motion/);
  });

  it('resources/read serves these exact bytes byte-for-byte (AC-1.6)', async () => {
    __setExecutionArtifactOverrideForTests(null); // use the REAL disk-loaded artifact
    const builtHtml = readFileSync(artifactPath, 'utf8');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'built-artifact', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
        })
      );
      const read = await client.readResource({ uri: 'ui://mma/execution.html' });
      expect((read.contents[0] as { text: string }).text).toBe(builtHtml);
    } finally {
      await client.close();
      await h.close();
    }
  });

  it('the served bytes execute for real: connect, deliver a running result, poll mma_execution_get (AC-1.7)', async () => {
    const html = readFileSync(artifactPath, 'utf8');
    const script = html.match(/<script[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
    expect(script).toBeTruthy();
    expect(script).not.toMatch(/^\s*(import|export)\s/m); // singlefile inlined every dependency

    // Construct from the REAL built bytes. A hand-made document would let this pass even if
    // the shipped HTML never contained the mount point entry.ts renders into — the
    // placeholder-ships-undetected failure this proof exists to catch. jsdom does not execute
    // <script type="module">, and forcing an IIFE build does not change that (the singlefile
    // plugin controls the tag attributes), so extract-and-eval is the one route that works.
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://app.local/' });
    expect(dom.window.document.querySelector('main#app')).not.toBeNull();

    // `eval` runs in script scope, where `import.meta` is a syntax error, so the raw module
    // body cannot be evaluated as-is. The bundle contains exactly ONE occurrence, inside a
    // Zod dynamic-import fallback that this code path never reaches; substituting a literal
    // URL keeps every executed statement byte-identical to what ships. Asserting the count
    // first means a future bundle that starts using `import.meta` somewhere live fails here
    // instead of being silently rewritten.
    expect(script!.match(/import\.meta/g) ?? []).toHaveLength(1);
    const evaluatable = script!.replace(/import\.meta\.url/g, JSON.stringify('https://app.local/execution.html'));

    const app = {
      connect: vi.fn().mockResolvedValue(undefined),
      ontoolresult: undefined as ((v: unknown) => void) | undefined,
      callServerTool: vi.fn((_p: { name: string; arguments: Record<string, unknown> }) =>
        Promise.resolve({ content: [{ type: 'text', text: JSON.stringify({
          executionId: 'from-run', status: 'running', phase: 'execute', elapsedMs: 1, phaseElapsedMs: 1, startedAt: '2026-01-01T00:00:00.000Z',
        }) }] })
      ),
    };
    (dom.window as unknown as { __MMA_CREATE_APP__: () => typeof app }).__MMA_CREATE_APP__ = () => app;
    (dom.window as unknown as { eval(source: string): unknown }).eval(evaluatable);

    app.ontoolresult?.({ content: [{ type: 'text', text: JSON.stringify({
      executionId: 'from-run', status: 'running', phase: 'queue', elapsedMs: 0, phaseElapsedMs: 0, startedAt: '2026-01-01T00:00:00.000Z',
    }) }] });
    await new Promise((r) => setTimeout(r, 0));

    // Read calls off the spy, not a hand-rolled recorder: a `mock*Once` override replaces the
    // implementation for the call it covers, so a manual array silently misses those calls.
    const calls = app.callServerTool.mock.calls.map(
      ([c]) => c as { name: string; arguments: Record<string, unknown> }
    );
    expect(calls).toContainEqual({ name: 'mma_execution_get', arguments: { executionId: 'from-run' } });
  });
});
