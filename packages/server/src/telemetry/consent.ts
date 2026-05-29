import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { decideConsent, type ConsentDecision } from '@zhixuan92/multi-model-agent-core/events/consent-rules';

// fs functions are injected (defaulting to the real node:fs) so tests can supply
// fakes WITHOUT a process-global `mock.module('node:fs')`, which under Bun is
// sticky and leaks the mock into every later test file.
type ReadFileSync = (path: string, enc: 'utf8') => string;
type Watch = typeof watch;

export function decide(homeDir: string, readFile: ReadFileSync = readFileSync): ConsentDecision {
  const env = process.env.MMAGENT_TELEMETRY;
  const cfgPath = join(homeDir, 'config.json');
  let config: { enabled: boolean } | { kind: 'unreadable' } | undefined = undefined;
  try {
    const txt = readFile(cfgPath, 'utf8');
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

export function watchConfigForChanges(
  homeDir: string,
  onChange: (d: ConsentDecision) => void,
  watchFn: Watch = watch,
  readFile: ReadFileSync = readFileSync,
): () => void {
  const filename = 'config.json';
  let timer: NodeJS.Timeout | null = null;
  const w = watchFn(homeDir, { persistent: false }, (_event, fname) => {
    if (fname !== filename) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(decide(homeDir, readFile)), 500);
  });
  return () => { w.close(); if (timer) clearTimeout(timer); };
}
