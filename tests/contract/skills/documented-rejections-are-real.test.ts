/**
 * A skill that promises a rejection must be promising one the engine performs.
 *
 * `mma-audit` documented: "`target.paths` MUST contain exactly one entry — the plan markdown.
 * Sending zero or 2+ entries → `400 invalid_request` with the message: *Plan audit takes exactly
 * one filePath…*". That message exists nowhere in `packages/`, `audit` has no preprocessor, and the
 * schema puts no maximum on `paths`. A two-path plan audit is ACCEPTED: the worker spends its
 * criteria loop auditing source files as though they were plans, and nothing in the response marks
 * the run as degraded.
 *
 * A promised-but-absent rejection is worse than no promise. It tells the caller a whole class of
 * mistake will be caught for them, so they stop checking for it — and the failure it hides is
 * silent by construction, because the request succeeds.
 *
 * This scans for error MESSAGES the docs quote and requires each to exist in the code that would
 * emit it. Quoted messages are the checkable part: a doc saying "returns 400" in prose may be
 * describing a real Zod refusal, but a doc quoting an exact string is asserting that string is
 * produced somewhere.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serverConfigSchema } from '@zhixuan92/multi-model-agent-core';

const SKILL_ROOTS = ['packages/server/src/skills'];
const CODE_ROOTS = ['packages/core/src', 'packages/server/src'];

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full, ext);
    return full.endsWith(ext) ? [full] : [];
  });
}

/** Every source file that could contain an error message. */
const codeText = CODE_ROOTS.flatMap((r) => walk(r, '.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const skillFiles = SKILL_ROOTS.flatMap((r) => walk(r, '.md'));

/**
 * Quoted error messages in a skill doc: an italicised or quoted sentence sitting near a status
 * code. Deliberately narrow — the goal is to catch a doc INVENTING an engine message, not to
 * police every sentence near the word "400".
 */
function quotedErrorMessages(text: string): string[] {
  const out: string[] = [];
  for (const [, quoted] of text.matchAll(/`400 invalid_request`[^\n]*?\*"([^"]{20,})"\*/g)) {
    out.push(quoted!);
  }
  return out;
}

describe('quoted rejection messages exist in the engine', () => {
  it('finds skills to scan', () => {
    expect(skillFiles.length).toBeGreaterThan(15);
    expect(codeText.length).toBeGreaterThan(10_000);
  });

  it.each(skillFiles)('%s quotes no error message the engine cannot emit', (file) => {
    const messages = quotedErrorMessages(readFileSync(file, 'utf8'));
    const invented = messages.filter((message) => {
      // Compare on a distinctive fragment: the doc may wrap or re-punctuate a long message.
      const fragment = message.slice(0, 40);
      return !codeText.includes(fragment);
    });
    expect(invented, `${file} quotes a 400 message no code produces: ${invented.join(' | ')}`)
      .toEqual([]);
  });

  it('audit still has no preprocessor, which is why the guardrail was absent', () => {
    // The premise behind the mma-audit correction. If audit ever gains one, the doc should be
    // revisited — a real guardrail could then be implemented and documented as enforced.
    const registry = readFileSync('packages/server/src/application/preprocessors/index.ts', 'utf8');
    expect(registry).not.toMatch(/\baudit\b\s*:/);
  });
});

/**
 * Documented limits must be the configured ones.
 *
 * `mma-context-blocks` advertised "max 50 MiB" per block and the router repeated it as the "Body
 * cap". The real default is 512 KiB — a hundredfold overstatement — and over REST the raw body is
 * capped at 256 KiB FIRST, so the doc's own advertised use case (register a large codebase summary
 * or a long error log) fails with an error that never mentions the block limit at all.
 *
 * Derived from the schema, so raising the limit updates the expectation rather than the test.
 */
describe('documented context-block limits match the configured defaults', () => {
  const limits = serverConfigSchema.parse({}).server.limits;
  const blockKiB = limits.maxContextBlockBytes / 1024;

  const DOCS = [
    'packages/server/src/skills/mma-context-blocks/SKILL.md',
    'packages/server/src/skills/multi-model-agent/SKILL.md',
  ];

  it.each(DOCS)('%s states the real per-block cap', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text, `should state ${blockKiB} KiB`).toContain(`${blockKiB} KiB`);
  });

  it.each(DOCS)('%s no longer advertises a cap the engine rejects', (file) => {
    const text = readFileSync(file, 'utf8');
    // Any MiB-scale claim is wrong by construction while the default is sub-MiB.
    expect(text).not.toMatch(/\bmax(?:imum)?\b[^.\n]{0,40}\d+\s*MiB/i);
  });
});

/**
 * The documented output path must be the one the engine derives.
 *
 * `mma-plan`'s table said "Auto-derived: `.mma/plans/YYYY-MM-DD-<spec-basename>.md`", which reads
 * as today's date prefixed onto the spec name. `deriveDefaultOutputPath` INHERITS the spec's dated
 * stem instead — the same file says so correctly 21 lines earlier ("no double-date"). A caller
 * following the table looks for `.mma/plans/2026-08-15-2026-07-06-claims-demo.md` and does not find
 * their plan.
 */
describe('the plan output-path doc matches the deriver', () => {
  it('states the inherited stem, not a fresh date prefix', async () => {
    const { deriveDefaultOutputPath } = await import(
      '../../../packages/server/src/application/preprocessors/derive-output-path.js'
    );
    const derived = deriveDefaultOutputPath({
      type: 'plan',
      paths: ['/p/.mma/specs/2026-07-06-claims-demo.md'],
      today: '2026-08-15',
      prompt: '',
    });
    // The behaviour: the spec's own date survives and today's is not prepended.
    expect(derived).toBe('.mma/plans/2026-07-06-claims-demo.md');

    const doc = readFileSync('packages/server/src/skills/mma-plan/SKILL.md', 'utf8');
    expect(doc, 'the table must show the inherited stem').toContain(derived);
    expect(doc, 'the table must not imply a fresh date prefix')
      .not.toMatch(/Auto-derived: `\.mma\/plans\/YYYY-MM-DD-/);
  });
});

/**
 * The documented terminal statuses must be the ones a caller can observe.
 *
 * `_shared/response-shape.md` listed four — done / done_with_concerns / failed / cancelled — while
 * `ExecutionStore` has a fifth: boot reconciliation marks a daemon-restart-orphaned execution
 * `interrupted`, and `GET /execution/:id` serves it from the store after restart. A consumer that
 * switches on the four documented values hits an unhandled state the first time a daemon is
 * restarted mid-run, which is exactly when it is least welcome.
 */
describe('the documented status set matches the store', () => {
  it('names every terminal state the store can persist', () => {
    const store = readFileSync('packages/server/src/application/execution-store.ts', 'utf8');
    const declared = /type StoredExecutionState = ([^;]+);/.exec(store);
    expect(declared, 'the state union moved — this test can no longer read it').not.toBeNull();

    const states = [...declared![1].matchAll(/'(\w+)'/g)]
      .map((m) => m[1]!)
      // `pending` is not terminal; `complete` is the store's spelling of the wire's `done`.
      .filter((s) => s !== 'pending' && s !== 'complete');

    const doc = readFileSync('packages/server/src/skills/_shared/response-shape.md', 'utf8');
    for (const state of states) {
      expect(doc, `the response-shape doc never mentions the terminal state '${state}'`)
        .toContain(state);
    }
  });
});
