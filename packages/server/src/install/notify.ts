/**
 * Phase 0 stub — Phase 2 swaps the body to call `recorder.recordSkillInstalled(...)`.
 * This indirection keeps install-writers from carrying a forward dependency on the
 * telemetry recorder before it exists.
 */
export function notifySkillInstalled(_skillId: string, _client: string): void {
  // intentional no-op until Phase 2
}
