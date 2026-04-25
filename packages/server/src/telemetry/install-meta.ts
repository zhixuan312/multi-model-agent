import type { InstallMetadataType } from '@zhixuan92/multi-model-agent-core/telemetry/types';

const KNOWN_LANG = new Set([
  'en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'pt', 'ru', 'it',
  'tr', 'ar', 'hi', 'vi', 'id', 'th', 'pl', 'nl', 'sv',
]);

function bucketTz(): InstallMetadataType['tzOffsetBucket'] {
  const utcHours = -new Date().getTimezoneOffset() / 60;
  if (utcHours <= -6) return 'utc_minus_12_to_minus_6';
  if (utcHours < 0) return 'utc_minus_6_to_0';
  if (utcHours < 6) return 'utc_0_to_plus_6';
  if (utcHours < 12) return 'utc_plus_6_to_plus_12';
  return 'utc_plus_12_to_plus_15';
}

function bucketLang(): InstallMetadataType['language'] {
  const raw = (process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
  const two = raw.split(/[._-]/)[0] ?? '';
  return KNOWN_LANG.has(two) ? (two as any) : 'other';
}

function bucketOs(): InstallMetadataType['os'] {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'other';
}

export function buildInstallMeta(args: {
  installId: string;
  mmagentVersion: string;
}): InstallMetadataType {
  return {
    installId: args.installId,
    mmagentVersion: args.mmagentVersion,
    os: bucketOs(),
    nodeMajor: String(process.versions.node.split('.')[0]),
    language: bucketLang(),
    tzOffsetBucket: bucketTz(),
  };
}
