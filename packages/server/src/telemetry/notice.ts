import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsentDecision } from '@zhixuan92/multi-model-agent-core/telemetry/consent-rules.js';

const FLAG_FILE = 'telemetry-notice-shown';
const HR = '────────────────────────────────────────────────────────────────────────────';
const PRIVACY_URL = 'https://github.com/zhixuan312/multi-model-agent/blob/main/docs/PRIVACY.md';

export type NoticeWriter = (message: string) => void;

function composeBanner(decision: ConsentDecision): string {
  if (decision.enabled) {
    return [
      HR,
      ' mmagent telemetry is ENABLED. Thanks for opting in.',
      '',
      ' We collect pseudonymous, low-cardinality usage statistics',
      ' (route usage, model families, task outcomes, bucketed costs/durations).',
      ' Never prompts, files, or paths.',
      '',
      ' Opt out anytime:',
      '   mmagent telemetry disable',
      '   or set MMAGENT_TELEMETRY=0',
      '   or add  "telemetry": { "enabled": false }  to ~/.multi-model/config.json',
      '',
      ` Full details + every field we collect: ${PRIVACY_URL}`,
      HR,
    ].join('\n');
  }

  if (decision.source === 'default') {
    return [
      HR,
      ' mmagent telemetry is OFF by default in this release (3.6.0).',
      '',
      ' When enabled, mmagent collects pseudonymous, low-cardinality usage stats',
      ' (route usage, model families, task outcomes, bucketed costs/durations).',
      ' Never prompts, files, or paths.',
      '',
      ' To opt IN and help us improve the tool:',
      '   mmagent telemetry enable',
      '   or set MMAGENT_TELEMETRY=1',
      '   or add  "telemetry": { "enabled": true }  to ~/.multi-model/config.json',
      '',
      ` Full details + every field we'd collect: ${PRIVACY_URL}`,
      HR,
    ].join('\n');
  }

  let extra = '';
  if (decision.source === 'env_invalid') {
    extra =
      '\n' +
      [
        '',
        ' If source is env_invalid: your MMAGENT_TELEMETRY env var has an unrecognized',
        ' value (e.g. "fales"). Telemetry is disabled fail-closed for safety. Use',
        ' "MMAGENT_TELEMETRY=0" to opt out, or "MMAGENT_TELEMETRY=1" to enable.',
      ].join('\n');
  } else if (decision.source === 'config_unreadable') {
    extra =
      '\n' +
      [
        '',
        ' If source is config_unreadable: ~/.multi-model/config.json could not be parsed.',
        ' Fix the file or remove it.',
      ].join('\n');
  }

  return [
    HR,
    ` mmagent telemetry is currently DISABLED (source: ${decision.source}).${extra}`,
    '',
    ' No anonymous usage data is collected from this install.',
    ' Re-enable: mmagent telemetry enable',
    ` Details:   ${PRIVACY_URL}`,
    HR,
  ].join('\n');
}

/**
 * Show the first-run telemetry banner to stderr if the notice flag is absent.
 * The flag is created ONLY after the banner write succeeds.
 * Does NOT call getOrCreateInstallId — the banner predates identity.
 */
export function showNotice(
  dir: string,
  decision: ConsentDecision,
  write: NoticeWriter = (msg: string) => process.stderr.write(msg + '\n'),
): void {
  const flagPath = join(dir, FLAG_FILE);
  if (existsSync(flagPath)) return;

  const banner = composeBanner(decision);
  try {
    write(banner);
    writeFileSync(flagPath, '', { mode: 0o644 });
  } catch {
    // If write fails, no flag is created — banner shown again next boot.
  }
}
