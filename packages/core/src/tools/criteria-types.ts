/**
 * Structured criterion shape used by all five read-only routes for
 * parallel-criteria fan-out. Each entry in the route's *_CRITERIA constant
 * becomes one sub-worker; the per-criterion description is the variable
 * suffix in the sub-worker's user message (the cached prefix carries
 * everything else).
 */
export interface CriterionEntry {
  /** "1", "2", ..., matches the position in the existing *_FAILURE_MODES list. */
  id: string;
  /** Short label, e.g. "RECOMMENDATION-COHERENCE". */
  title: string;
  /** Verbatim prose from the existing failure-mode description, sans the
   *  leading "N. TITLE — " prefix. */
  description: string;
}

/**
 * Parses a `*_FAILURE_MODES` joined string back into structured criterion
 * entries. Each route's implementer-criteria.ts already authors its
 * taxonomy as a numbered list (`'1. TITLE — description...'`); this lets
 * the parallel-criteria dispatcher iterate without duplicating the prose.
 *
 * Expected line shape per criterion: `^N. TITLE — description$`
 * (em-dash with surrounding spaces; title may contain hyphens or slashes).
 */
export function parseCriteria(failureModesText: string): CriterionEntry[] {
  const out: CriterionEntry[] = [];
  const lines = failureModesText.split('\n');
  // Regex: leading digits + dot + space, capture title up to ' — ' separator,
  // then capture rest of line as description.
  const re = /^(\d+)\.\s+([^—]+?)\s+—\s+(.+)$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const [, id, title, description] = m;
    out.push({ id, title: title.trim(), description: description.trim() });
  }
  return out;
}
