/**
 * A committed doc that names a file or a route must name one that exists.
 *
 * `docs/ARCHITECTURE.md` is what CLAUDE.md tells a new contributor to "read first when orienting",
 * and it described an API the engine does not have:
 *
 *   `POST /task` · `GET /task/:taskId` · `DELETE /task/:taskId` · `handlers/unified-task.ts`
 *
 * The real surface is `POST /execution`, `GET|DELETE /execution/:executionId`, and
 * `handlers/unified-execution.ts`. It also called the registry class `TaskRegistry`; the class
 * exported from `unified/task-registry.ts` is `ExecutionRegistry` — the FILE kept its old name,
 * which is exactly how the prose kept the old one too.
 *
 * Nothing could catch it. Prose is not compiled, docs/ is not imported by any test, and the rename
 * touched code that all kept building. So the doc a newcomer is pointed at first was the one place
 * in the repo still describing the previous API.
 *
 * Two checks, both derived:
 *   1. Every `path/like/this.ts` a doc mentions in backticks resolves to a real file.
 *   2. Every `METHOD /route` a doc mentions is in the route golden — which the manifest test in turn
 *      holds against the router's own registration list.
 *
 * Deliberately narrow: it does not judge whether the prose is CORRECT, only that its nouns exist.
 * That is enough to catch a rename, which is what actually happens.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import routesGolden from './goldens/routes.json' with { type: 'json' };

/** Every committed markdown doc under docs/, recursively. */
function docFiles(dir = 'docs'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? docFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );
}

const DOCS = docFiles();

/**
 * Paths a doc may name that are NOT files in this repo: a consumer's own project files, a local
 * gitignored harness file, and the illustrative placeholders in the skill-writing guide.
 */
const NOT_OURS = new Set([
  '.vscode/mcp.json',        // written into the USER's project by `mma mcp install vscode`
  '.claude/CLAUDE.md',       // local harness config, gitignored by design
  '_shared/x.md',            // placeholder in an include-syntax example
  '_shared/y.md',
]);

/** Where a doc-relative path might really live. */
function resolves(p: string): boolean {
  return [
    p,
    join('packages', p),
    join('packages/core/src', p),
    join('packages/server/src', p),
    join('packages/server/src/http', p),
    join('packages/core', p),
    join('packages/server', p),
    join('plugin', p),
  ].some((c) => existsSync(c));
}

describe('docs name files that exist', () => {
  it('finds docs to check', () => {
    // Floor: an empty glob would make every case below vacuous.
    expect(DOCS.length).toBeGreaterThan(3);
  });

  it.each(DOCS)('%s', (doc) => {
    const text = readFileSync(doc, 'utf8');
    const bad: string[] = [];
    for (const m of text.matchAll(/`([a-zA-Z0-9_.-]+\/[a-zA-Z0-9/._-]+\.(?:ts|mjs|cjs|json|md))`/g)) {
      const p = m[1]!;
      if (NOT_OURS.has(p) || resolves(p)) continue;
      bad.push(`${doc}:${text.slice(0, m.index).split('\n').length} → ${p}`);
    }
    expect(bad, `doc names path(s) that do not exist:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('docs name routes that exist', () => {
  const ROUTES = new Set(routesGolden as string[]);

  it('the golden is populated', () => {
    expect(ROUTES.size).toBeGreaterThan(5);
  });

  it.each(DOCS)('%s', (doc) => {
    const text = readFileSync(doc, 'utf8');
    const bad: string[] = [];
    for (const m of text.matchAll(/\b(GET|POST|DELETE|PUT|PATCH) (\/[a-zA-Z0-9/:_-]+)/g)) {
      // A doc may name a DEAD route in order to forbid it — SKILL_WRITING_GUIDELINES lists the
      // retired spellings on purpose, so a skill copying an old example is still caught. The
      // exemption keys on the word "retired" and nothing else: it must be stated, in the same line,
      // that the route is gone.
      //
      // The first version of this skipped any line matching /no|not|never|forbidden/, which
      // exempted ARCHITECTURE.md's own ingress paragraph — it ends "It owns no task logic." So the
      // drift this whole test was written for went undetected by it. An exemption keyed on common
      // English words exempts most prose.
      const line = text.slice(0, m.index).split('\n').length;
      const lineText = text.split('\n')[line - 1] ?? '';
      if (/\bretired\b/i.test(lineText)) continue;
      const method = m[1]!;
      // Normalise a concrete path param to the golden's placeholder form: the golden says
      // `/execution/:executionId`, prose may say `/execution/<id>` or name the param differently.
      const path = m[2]!.replace(/\/:[a-zA-Z]+$/, '/:PARAM').replace(/\/<[^>]+>$/, '/:PARAM');
      const known = [...ROUTES].some(
        (r) => r === `${method} ${path}` || r.replace(/\/:[a-zA-Z]+$/, '/:PARAM') === `${method} ${path}`,
      );
      if (!known) bad.push(`${doc}:${text.slice(0, m.index).split('\n').length} → ${method} ${m[2]}`);
    }
    expect(bad, `doc names route(s) the router does not register:\n${bad.join('\n')}`).toEqual([]);
  });
});
