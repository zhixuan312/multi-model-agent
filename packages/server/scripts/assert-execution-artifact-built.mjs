#!/usr/bin/env node
/**
 * Publication guard: refuse to publish a package whose execution-monitor App was never built.
 *
 * The App resource degrades gracefully at runtime — a missing bundle serves a placeholder and
 * the daemon keeps working — which is right for a dev checkout and exactly wrong for a
 * published tarball, where it would ship a permanently broken MCP App with no error anywhere.
 * Graceful degradation is why this guard has to exist: nothing else would ever complain.
 *
 * Resolves the artifact relative to its OWN location, so it behaves identically wherever it
 * is invoked from. Exit code is the whole signal — no exception, no stdout.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(here, '..', 'dist', 'ui', 'execution.html');
const PLACEHOLDER_MARKER = '<!-- mma: execution app not built';

if (!existsSync(artifactPath)) {
  process.stderr.write(
    `assert-execution-artifact-built: missing ${artifactPath}. Run the package build before publishing.\n`
  );
  process.exit(1);
}

const html = readFileSync(artifactPath, 'utf8');

// Match the runtime loader's own availability rule (`execution-artifact.ts` treats empty
// content as unavailable). If the guard were more permissive than the loader, an empty
// artifact — what a truncated or interrupted build leaves behind — would satisfy the guard,
// publish, and then serve the placeholder anyway: the failure this script exists to prevent,
// reached by passing it.
if (html.length === 0) {
  process.stderr.write(
    `assert-execution-artifact-built: ${artifactPath} is empty. Run the package build before publishing.\n`
  );
  process.exit(1);
}

if (html.startsWith(PLACEHOLDER_MARKER)) {
  process.stderr.write(
    `assert-execution-artifact-built: ${artifactPath} is still the unbuilt placeholder. Run the package build before publishing.\n`
  );
  process.exit(1);
}

process.exit(0);
