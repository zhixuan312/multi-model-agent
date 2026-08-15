/**
 * Every worker prompt's output example must validate against the schema that parses it.
 *
 * `execute_plan/implement.md` showed `{"tasks": [{"title": …, "status": …}]}` — the title-only
 * shape `reviewer-output-shape.test.ts` explicitly asserts must NOT validate, because
 * `executePlanAnswerSchema` requires `id` and `contract-match.ts` resolves tasks by it. That test's
 * own header documents the regression it came from: every run failing schema validation with
 * `reviewer_unavailable` and falling through to `contract_unverifiable`. The 2026 fix reached
 * `review.md` and not `implement.md`, and the refiner is told to re-output "in the same JSON format
 * as the implementer" — pointing it straight back at the broken example.
 *
 * A prompt's example is the shape the worker copies. Checking it against the parser is the whole
 * job, and no test did it: the existing one checks hand-written literals, not the prompts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REFINER_SCHEMAS } from '../../../packages/core/src/unified/refiner-schemas.js';

const SKILLS_DIR = 'packages/core/src/skills';

/**
 * The LAST fenced json block in a prompt — the one under `## Output`, which is what the worker is
 * told to emit. Earlier blocks are inputs or illustrations.
 */
function finalJsonExample(text: string): string | null {
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
  return blocks.length > 0 ? blocks[blocks.length - 1]! : null;
}

/** Prompt placeholders are not JSON. Resolve the conventional ones so the SHAPE can be parsed. */
function resolvePlaceholders(raw: string): string {
  return raw
    // "done|failed" / "critical|high|…" → pick the first alternative
    .replace(/"([a-z_]+)\|[a-z_|]+"/g, '"$1"')
    // "<anything>" → a non-empty string
    .replace(/"<[^">]*>"/g, '"x"')
    // bare <number> placeholders
    .replace(/:\s*<[^>,}]*>/g, ': 0');
}

type SchemaRoute = keyof typeof REFINER_SCHEMAS;

const routesWithSchema = (Object.keys(REFINER_SCHEMAS) as SchemaRoute[]).filter(
  (route) => existsSync(join(SKILLS_DIR, route, 'implement.md')),
);

/**
 * `journal_record`'s implementer emits a DECISION ARRAY, parsed by `journal_record_decision`, not
 * the answer schema its route name would suggest — the answer shape belongs to the deterministic
 * engine's own result. So its example is checked against both, and passes if either accepts it.
 */
const ALTERNATE_SCHEMA: Partial<Record<SchemaRoute, SchemaRoute>> = {
  journal_record: 'journal_record_decision',
};

describe("each prompt's output example matches its refiner schema", () => {
  it('finds routes to check', () => {
    // Eleven routes reach the assertion below. The old floor of 5 would still have passed with
    // more than half of them silently dropped by a resolver or glob change.
    expect(routesWithSchema.length).toBeGreaterThanOrEqual(11);
  });

  it.each(routesWithSchema)('%s implementer example validates', (route) => {
    const text = readFileSync(join(SKILLS_DIR, route, 'implement.md'), 'utf8');
    const raw = finalJsonExample(text);
    expect(raw, `${route}/implement.md has no fenced json output example`).not.toBeNull();

    /**
     * Parse failure is a FAILURE, not a skip.
     *
     * This used to `return` here, with the note "several use prose annotations inside the block.
     * Only well-formed examples are held to the schema." Measured: all eleven examples parse, so
     * the exemption covers nothing — and it never protected a real case, it only guaranteed that
     * the day one stopped parsing, this test would go green instead of red. That is backwards. A
     * prompt's output example is the shape the worker copies; an example that is not even JSON is
     * a worse defect than one whose fields are wrong, and it was the only kind this test excused.
     *
     * If a genuinely prose-annotated example is ever needed, `resolvePlaceholders` is where the
     * convention belongs — a named placeholder form that resolves, not a blanket catch.
     */
    let parsed: unknown;
    try {
      parsed = JSON.parse(resolvePlaceholders(raw!));
    } catch (err) {
      expect.fail(
        `${route}/implement.md's output example is not parseable JSON after placeholder resolution `
        + `— the worker is shown a shape it cannot copy: ${(err as Error).message}`,
      );
    }

    const candidates: SchemaRoute[] = [route];
    const alternate = ALTERNATE_SCHEMA[route];
    if (alternate) candidates.push(alternate);

    const accepted = candidates.some((key) => REFINER_SCHEMAS[key]!.safeParse(parsed).success);
    const first = REFINER_SCHEMAS[route]!.safeParse(parsed);
    expect(
      accepted,
      `${route}/implement.md shows a shape its own parser rejects: ${
        first.success ? '' : JSON.stringify(first.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`))
      }`,
    ).toBe(true);
  });
});
