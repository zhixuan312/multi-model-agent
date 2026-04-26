import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { decideConsent, type ConsentDecision } from '@zhixuan92/multi-model-agent-core/telemetry/consent-rules';

export function decide(homeDir: string): ConsentDecision {
  const env = process.env.MMAGENT_TELEMETRY;
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

export function watchConfigForChanges(homeDir: string, onChange: (d: ConsentDecision) => void): () => void {
  const filename = 'config.json';
  let timer: NodeJS.Timeout | null = null;
  const w = watch(homeDir, { persistent: false }, (_event, fname) => {
    if (fname !== filename) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(decide(homeDir)), 500);
  });
  return () => { w.close(); if (timer) clearTimeout(timer); };
}
