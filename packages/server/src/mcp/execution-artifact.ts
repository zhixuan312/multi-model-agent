import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one MCP App resource this daemon ever serves: a self-contained
 * execution-monitor page rendered by MCP-App-capable hosts (Claude Desktop).
 * Frozen so `tool-surface.ts` and `mcp-adapter.ts` share a single source of
 * truth instead of re-declaring these literals.
 */
/**
 * Stable identity of the execution-app resource, WITHOUT the build fingerprint.
 * `resources/read` still accepts this exact form — see `executionResourceUriMatches`.
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

/**
 * Advertised URI for the execution app, carrying a fingerprint of the bytes it serves:
 * `ui://mma/execution.html?v=<8 hex>`.
 *
 * Hosts cache a UI resource by URI, and Claude Desktop caches it hard — hard enough that a
 * rebuilt bundle kept being served stale across daemon restarts and new conversations. As a
 * development annoyance that is merely slow; in production it is a shipping bug, because a
 * user who UPGRADES mma would keep running the old App indefinitely with no way to know. A
 * fixed URI gives the host nothing to invalidate on.
 *
 * Content-addressing fixes it at the only layer that can: new bytes produce a new URI, so the
 * cache misses exactly when it should and hits every other time.
 */
export function getExecutionResourceUri(): string {
  const artifact = getExecutionArtifact();
  if (!artifact.available) return EXECUTION_RESOURCE_URI;
  return `${EXECUTION_RESOURCE_URI}?v=${fingerprint(artifact.html)}`;
}

/**
 * Accept the versioned URI AND the bare one.
 *
 * A host that cached an OLDER fingerprint will ask for that older URI. Refusing it would turn
 * a stale cache into a hard failure — strictly worse than serving current bytes under a name
 * the host happens to remember, since the response body is the truth either way. Any `?v=`
 * is therefore accepted and ignored; only the path has to match.
 */
export function executionResourceUriMatches(uri: string): boolean {
  const [base] = uri.split('?');
  return base === EXECUTION_RESOURCE_URI;
}

function fingerprint(html: string): string {
  // Cheap, dependency-free FNV-1a. This is a cache key, not a security boundary — it only
  // needs to change when the bytes change.
  let hash = 0x811c9dc5;
  for (let i = 0; i < html.length; i += 1) {
    hash ^= html.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Mix in the length so two files differing only by a transposition cannot collide trivially.
  return ((hash ^ html.length) >>> 0).toString(16).padStart(8, '0');
}

