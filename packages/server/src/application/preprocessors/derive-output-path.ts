import * as path from 'node:path';

export type SpecOrPlanType = 'spec' | 'plan';

/** A dated artifact basename opens with a `YYYY-MM-DD-` stem prefix. */
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export interface DeriveDefaultOutputPathArgs {
  /** The task type — only 'spec' and 'plan' derive a default output path. */
  type: SpecOrPlanType;
  /** The task prompt (used to slugify the spec filename when self-naming). */
  prompt: string;
  /** All `target.paths` entries in order; undefined/empty for inline. */
  paths?: string[] | undefined;
  /** Today's date as YYYY-MM-DD. Injected so the derivation is pure/testable. */
  today: string;
}

/**
 * The basename (without extension) of the FIRST `paths` entry that carries a
 * `YYYY-MM-DD-` stem prefix — i.e. the dated upstream artifact (exploration for a
 * spec, spec for a plan). Undated inputs (e.g. a scratchpad decisions scaffold) are
 * skipped. Pure/path-string-only: operates on `path.basename`, never the filesystem,
 * so it cannot throw on a missing file.
 */
function firstDatedBasename(paths: string[] | undefined): string | null {
  if (!paths) return null;
  for (const p of paths) {
    const base = path.basename(p, path.extname(p));
    if (DATE_PREFIX.test(base)) return base;
  }
  return null;
}

/**
 * Derive the default artifact output path for a spec or plan task when the caller
 * did not supply `outputPath`.
 *
 * One uniform rule keeps the whole SDLC chain on a single stem `<date>-<slug>`:
 * inherit the stem from the first date-prefixed input, skipping undated scaffolds.
 *
 *   - spec → `.mma/specs/<dated-stem>.md` when a dated input is present (the
 *            exploration); otherwise `.mma/specs/<today>-<slug>.md`
 *            (`<slug>` = first sentence of the prompt, kebab-cased, ≤60 chars;
 *            falls back to `spec` when the prompt slugifies to empty)
 *   - plan → `.mma/plans/<dated-stem>.md` when a dated input is present (the spec);
 *            otherwise `.mma/plans/<today>-<basename>.md` from the first input, or
 *            `null` when there is no input at all (inline — caller requires outputPath)
 *
 * Returns `null` when no default can be derived. The caller rejects a plan with
 * inline content and no `target.paths` with HTTP 400 before reaching derivation, so
 * the null branch is defensive.
 */
export function deriveDefaultOutputPath(args: DeriveDefaultOutputPathArgs): string | null {
  const { type, prompt, paths, today } = args;
  const datedStem = firstDatedBasename(paths);

  if (type === 'spec') {
    if (datedStem) return `.mma/specs/${datedStem}.md`;
    const slug = prompt.split(/[.!?\n]/)[0].trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    return `.mma/specs/${today}-${slug || 'spec'}.md`;
  }

  // type === 'plan'
  if (datedStem) return `.mma/plans/${datedStem}.md`;
  if (paths && paths.length > 0) {
    const base = path.basename(paths[0], path.extname(paths[0]));
    return `.mma/plans/${today}-${base}.md`;
  }
  return null;
}
