export const SPEC_COMPONENTS = [
  'Context',
  'Problem',
  'Goals & Requirements',
  'Alternatives',
  'Technical Design',
  'Testing Plan',
  'Risks & Mitigations',
  'User Stories & Tasks',
] as const;

export type SpecComponent = typeof SPEC_COMPONENTS[number];

export function resolveComponents(
  components: readonly SpecComponent[] | undefined,
): SpecComponent[] {
  if (!components || components.length === 0) {
    return [...SPEC_COMPONENTS];
  }

  const requested = new Set(components);
  return SPEC_COMPONENTS.filter((component) => requested.has(component));
}

/**
 * One component catalog entry: the stable wire identifier plus a neutral display label
 * suitable for a spec that does not assume a software deliverable. `id` is byte-identical
 * to one `SPEC_COMPONENTS` entry and drives `resolveComponents()`; `displayLabel` is what
 * a newly authored spec heading shows.
 */
export interface SpecComponentCatalogEntry {
  id: SpecComponent;
  displayLabel: string;
}

/** Only these three identifiers get a neutral label; the other five keep their current
 *  text as their own display label. */
const NEUTRAL_DISPLAY_LABELS: Partial<Record<SpecComponent, string>> = {
  'Technical Design': 'Approach, Method & Structure',
  'Testing Plan': 'Verification Plan',
  'User Stories & Tasks': 'Stakeholders & Work',
};

export const SPEC_COMPONENT_CATALOG: readonly SpecComponentCatalogEntry[] = SPEC_COMPONENTS.map((id) => ({
  id,
  displayLabel: NEUTRAL_DISPLAY_LABELS[id] ?? id,
}));

/**
 * Dual-read resolver: maps either a CURRENT display label (e.g. `'Approach, Method &
 * Structure'`) or a HISTORICAL heading (the stable identifier itself, e.g.
 * `'Technical Design'`) back to the stable `SpecComponent` identifier. A spec file
 * written before the display-label change still parses, because its heading text is the
 * identifier, and a spec file written after the change parses too, because its heading
 * text is the display label. Returns `undefined` when `heading` matches neither.
 */
export function resolveComponentHeading(heading: string): SpecComponent | undefined {
  const trimmed = heading.trim();
  const byIdentifier = SPEC_COMPONENTS.find((id) => id === trimmed);
  if (byIdentifier) return byIdentifier;
  const byDisplayLabel = SPEC_COMPONENT_CATALOG.find((entry) => entry.displayLabel === trimmed);
  return byDisplayLabel?.id;
}
