import { getRecorder } from '../telemetry/recorder.js';

export function notifySkillInstalled(skillId: string, client: string): void {
  try {
    getRecorder().recordSkillInstalled(skillId, client);
  } catch { /* silent */ }
}
