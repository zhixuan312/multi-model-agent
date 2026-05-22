export function normalize(spec, { response = null, diagnostics = null, queue = null, backend = null } = {}) {
  return { scenarioId: spec.id, route: spec.route, expect: spec, response, diagnostics, queue, backend };
}
