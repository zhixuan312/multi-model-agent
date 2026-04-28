const READ_ONLY_ROUTES = [
  'audit_document', 'review_code', 'verify_work', 'investigate_codebase', 'debug_task',
] as const;

type ReadOnlyRoute = (typeof READ_ONLY_ROUTES)[number];

export interface ReadOnlyReviewFlag {
  isEnabledFor(route: ReadOnlyRoute): boolean;
}

export function resolveReadOnlyReviewFlag(): ReadOnlyReviewFlag {
  const raw = process.env['MMAGENT_READ_ONLY_REVIEW'];
  if (raw === undefined) return { isEnabledFor: () => true };
  if (raw === 'disabled') return { isEnabledFor: () => false };
  const allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return { isEnabledFor: (route) => allowed.has(route) };
}
