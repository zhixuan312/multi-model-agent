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
