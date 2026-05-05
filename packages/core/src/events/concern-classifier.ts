export type ConcernCategory =
  | 'missing_test' | 'scope_creep' | 'incomplete_impl' | 'style_lint'
  | 'security' | 'performance' | 'maintainability' | 'doc_gap'
  | 'doc_drift' | 'contract_violation' | 'coverage_gap' | 'dead_code' | 'queue_hygiene'
  | 'other';

interface RawConcern {
  source:   string; // 'spec_review' | 'quality_review' | 'diff_review' | …
  severity: string; // 'critical' | 'high' | 'medium' | 'low' (4-tier SeverityBin)
  message:  string;
}

// Each pattern is fully parenthesized to avoid alternation-precedence bugs
// (e.g. `\bmissing|no\s+test` parses as `(\bmissing) | (no\s+test)` — the
// word-boundary applies only to "missing", which silently matches "no known
// issue"). Wrap the alternation explicitly so `\b` covers every branch.
const PATTERNS: Array<[RegExp, ConcernCategory]> = [
  [/\b(?:(?:missing|no)\s+(?:unit\s+)?tests?|untested)\b/i,                       'missing_test'],
  [/\b(?:sqli?|sql\s*injection|xss|secret|api[\s_-]*key|token|cred(?:ential)?s?)\b/i, 'security'],
  [/\b(?:O\([^)]+\)|hot\s*path|n\^?2|quadratic|slow\s+loop)\b/i,                  'performance'],
  [/\b(?:unrelated\s+(?:refactor|change)|scope[\s_-]*creep|out\s+of\s+scope)\b/i, 'scope_creep'],
  [/\b(?:TODO|FIXME|incomplete|not\s+implemented|stub)\b/i,                       'incomplete_impl'],
  [/\b(?:style|naming|camelCase|snake_case|formatting|lint(?:er)?)\b/i,           'style_lint'],
  [/\b(?:readme|doc(?:ument(?:ing|ation)?|s)?|comment|jsdoc)\b/i,                 'doc_gap'],
  [/\b(?:extract(?:ing)?|refactor|maintain|coupl(?:ing)?|cohes(?:ion)?)\b/i,       'maintainability'],
  [/\b(?:stale|out[\s-]*of[\s-]*date|obsolete|no longer accurate)\b/i,              'doc_drift'],
  [/\b(?:envelope|contract|wire[\s-]*format|public[\s-]*api|gate(?:s|d)?)\b/i,      'contract_violation'],
  [/\b(?:missing[\s-]*coverage|coverage[\s-]*gap|skipped\b[\s\w-]*\btest|(?:no|without)[\s-]+(?:an?\s+)?(?:active\s+)?replacement)\b/i, 'coverage_gap'],
  [/\b(?:dead[\s-]*code|unused[\s-]*(?:seam|export|symbol)|stale[\s-]*comment|legacy[\s-]*field)\b/i, 'dead_code'],
  [/\b(?:queue|tracker|prq|backlog)\b.*\b(?:hygiene|stale|cleanup|historical)\b/i,  'queue_hygiene'],
];

export function classifyConcern(c: RawConcern): ConcernCategory {
  for (const [re, cat] of PATTERNS) if (re.test(c.message)) return cat;
  return 'other';
}
