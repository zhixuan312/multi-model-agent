import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideConsent, type ConsentDecision } from '@zhixuan92/multi-model-agent-core/events/consent-rules';

export function decide(homeDir: string): ConsentDecision {
  const env = process.env.MMA_TELEMETRY;
  const cfgPath = join(homeDir, 'config.json');
  let config: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
  try {
    const txt = readFileSync(cfgPath, 'utf8');
    const obj = JSON.parse(txt) as any;
    if (
      obj && typeof obj === 'object' && obj.telemetry &&
      typeof obj.telemetry === 'object' &&
      typeof obj.telemetry.enabled === 'boolean'
    ) {
      config = { enabled: obj.telemetry.enabled };
    } else if (obj && typeof obj === 'object' && typeof obj.enabled === 'boolean') {
      config = { enabled: obj.enabled };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      config = { kind: 'unreadable' };
    }
  }
  return decideConsent({ env, config });
}
