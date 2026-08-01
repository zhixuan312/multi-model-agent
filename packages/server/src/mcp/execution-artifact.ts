import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one MCP App resource this daemon ever serves: a self-contained
 * execution-monitor page rendered by MCP-App-capable hosts (Claude Desktop).
 * Frozen so `tool-surface.ts` and `mcp-adapter.ts` share a single source of
 * truth instead of re-declaring these literals.
 */
export const EXECUTION_RESOURCE_URI = 'ui://mma/execution.html';
export const EXECUTION_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * JSON-RPC error code for "resource not found". SDK 1.30.0's `ErrorCode`
 * enum has no `ResourceNotFound` member, so this is a named local constant
 * rather than an SDK re-export.
 */
export const RESOURCE_NOT_FOUND = -32002;

const UNBUILT_PLACEHOLDER = '<!-- mma: execution app not built — run `npm run build` -->';

export interface ExecutionArtifact {
  html: string;
  available: boolean;
}

/**
 * Resolve the compiled execution-app bundle path from a module URL.
 *
 * PURE function — takes its base as an argument rather than reading
 * `import.meta.url` internally, precisely so both source-mode (Vitest runs
 * this package straight from `src/` via the workspace alias) and
 * compiled-mode (`dist/mcp/*.js`) callers can be exercised by tests. A
 * resolver that closes over its own module URL could only ever be exercised
 * in whichever mode the test happens to run in, making the regression it
 * guards against untestable by construction.
 *
 * Always resolves to `packages/server/dist/ui/execution.html` — from
 * compiled `dist/mcp/*` that is the adjacent `../ui/execution.html`; from
 * source/Vitest execution it resolves explicitly to the package's
 * `dist/ui/execution.html`, never to the unbundled `src/ui/execution/
 * execution.html`.
 */
export function resolveExecutionArtifactPath(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const marker = `${sep}packages${sep}server${sep}`;
  const markerIndex = modulePath.indexOf(marker);
  const packageRoot = markerIndex === -1
    ? modulePath
    : modulePath.slice(0, markerIndex + marker.length);
  return join(packageRoot, 'dist', 'ui', 'execution.html');
}

function loadArtifact(): ExecutionArtifact {
  try {
    const path = resolveExecutionArtifactPath(import.meta.url);
    const html = readFileSync(path, 'utf8');
    if (!html) {
      return { available: false, html: UNBUILT_PLACEHOLDER };
    }
    return { available: true, html };
  } catch {
    // ENOENT, permission error, or any other read failure — never throw at
    // module-scope. The loader runs at import time; throwing here would fail
    // the entire suite at import, not just the UI-related tests.
    return { available: false, html: UNBUILT_PLACEHOLDER };
  }
}

// Evaluated once per process, at module scope. Never re-read from disk.
const cachedArtifact: ExecutionArtifact = loadArtifact();

let testOverride: ExecutionArtifact | null = null;

/** Returns the same cached object on every call — never re-reads disk. */
export function getExecutionArtifact(): ExecutionArtifact {
  return testOverride ?? cachedArtifact;
}

/**
 * Test-only override to force either branch without touching the real
 * filesystem. Mirrors the `__setCoreTestProviderOverride` convention in
 * `tests/contract/fixtures/harness.ts`. Pass `null` to clear the override
 * back to the real cached/disk-derived value. Never read on any production
 * code path.
 */
export function __setExecutionArtifactOverrideForTests(value: ExecutionArtifact | null): void {
  testOverride = value;
}
