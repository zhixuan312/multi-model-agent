const PII_FIELDS = ['userMessage', 'assistantText', 'fileContents'] as const;

export function privacyFilter(record: Record<string, unknown>): Record<string, unknown> {
  const out = { ...record };
  for (const f of PII_FIELDS) {
    if (f in out) delete out[f];
  }
  return out;
}
