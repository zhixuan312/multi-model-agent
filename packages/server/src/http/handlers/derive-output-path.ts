import * as path from 'node:path';

export type SpecOrPlanType = 'spec' | 'plan';

export interface DeriveDefaultOutputPathArgs {
  /** The task type — only 'spec' and 'plan' derive a default output path. */
  type: SpecOrPlanType;
  /** The task prompt (used to slugify the spec filename). */
  prompt: string;
  /** target.paths[0] when the task carries a source file; undefined for inline. */
  firstPath?: string | undefined;
  /** Today's date as YYYY-MM-DD. Injected so the derivation is pure/testable. */
  today: string;
}

/**
 * Derive the default artifact output path for a spec or plan task when the
 * caller did not supply `outputPath`.
 *
 * Artifacts live under `.mma/`, alongside the journal (`.mma/journal/`):
 *   - spec → `.mma/specs/<today>-<slug>.md`
 *            (`<slug>` = first sentence of the prompt, kebab-cased, ≤60 chars;
 *            falls back to `spec` when the prompt slugifies to empty)
 *   - plan → `.mma/plans/<today>-<spec-basename>.md`
 *            (or `.mma/plans/<spec-basename>.md` when the source basename
 *            already carries a `YYYY-MM-DD-` prefix)
 *
 * Returns `null` when no default can be derived — a plan with inline content
 * and no `target.paths`, where no basename exists to build the filename from.
 * The caller rejects that case with HTTP 400 before reaching derivation, so the
 * null branch is defensive.
 */
export function deriveDefaultOutputPath(args: DeriveDefaultOutputPathArgs): string | null {
  const { type, prompt, firstPath, today } = args;

  if (type === 'spec') {
    const slug = prompt.split(/[.!?\n]/)[0].trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return `.mma/specs/${today}-${slug || 'spec'}.md`;
  }

  // type === 'plan'
  if (firstPath) {
    const specBase = path.basename(firstPath, path.extname(firstPath));
    const hasDatePrefix = /^\d{4}-\d{2}-\d{2}-/.test(specBase);
    return hasDatePrefix
      ? `.mma/plans/${specBase}.md`
      : `.mma/plans/${today}-${specBase}.md`;
  }

  return null;
}
