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
