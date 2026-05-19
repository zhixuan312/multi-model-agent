// EvidencePack types + deterministic truncation policy per spec §5.3 / §5.4.

export type SourceGroup =
  | 'arxiv' | 'semantic_scholar' | 'github_repo' | 'github_code'
  | 'web_fetch' | 'rss' | 'brave';

export interface EvidenceSource {
  source:       SourceGroup;
  query:        string;
  title:        string;
  url:          string;
  snippet:      string;
  publishedAt?: string;
  rank:         number;
}

export interface FailedAttempt {
  source:  SourceGroup;
  query:   string;
  reason:  string;
  detail?: string;
}

export interface EvidencePack {
  sources:        EvidenceSource[];
  failedAttempts: FailedAttempt[];
  generatedAt:    string;
  totalQueries:   number;
  budgetExceeded: boolean;
}

export const EVIDENCE_PACK_LIMITS = Object.freeze({
  MAX_TOTAL_BYTES:   48 * 1024,
  MAX_PER_GROUP:     10,
  MAX_SNIPPET_CHARS: 500,
  MAX_TOTAL_SOURCES: 50,
});

// Drop priority: lowest-priority group dropped first.
const DROP_PRIORITY: SourceGroup[] = [
  'brave', 'rss', 'web_fetch',
  'github_code', 'github_repo', 'semantic_scholar', 'arxiv',
];

// Within a group, priority is preserved by input order (highest first).
function groupPriority(group: SourceGroup): number {
  return DROP_PRIORITY.indexOf(group);
}

export function dedupSources(input: EvidenceSource[]): EvidenceSource[] {
  // Sort so highest-priority (latest in DROP_PRIORITY) wins on URL collision.
  const sorted = [...input].sort(
    (a, b) => groupPriority(b.source) - groupPriority(a.source),
  );
  const seen = new Set<string>();
  const kept: EvidenceSource[] = [];
  for (const s of sorted) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    kept.push(s);
  }
  return kept;
}

export function applyBudget(
  inputSources: EvidenceSource[],
  failedAttempts: FailedAttempt[],
): EvidencePack {
  let budgetExceeded = false;

  // 1. Dedup.
  let sources = dedupSources(inputSources);

  // 2. Per-group cap.
  const perGroup = new Map<SourceGroup, EvidenceSource[]>();
  for (const s of sources) {
    if (!perGroup.has(s.source)) perGroup.set(s.source, []);
    perGroup.get(s.source)!.push(s);
  }
  let totalAfterCap = 0;
  for (const [, list] of perGroup) {
    if (list.length > EVIDENCE_PACK_LIMITS.MAX_PER_GROUP) {
      list.length = EVIDENCE_PACK_LIMITS.MAX_PER_GROUP;
      budgetExceeded = true;
    }
    totalAfterCap += list.length;
  }
  sources = ([] as EvidenceSource[]).concat(...perGroup.values());

  // 3. Total-sources cap. Drop lowest-priority groups first.
  while (sources.length > EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES) {
    budgetExceeded = true;
    let dropped = false;
    for (const g of DROP_PRIORITY) {
      const idx = sources.findIndex(s => s.source === g);
      if (idx >= 0) {
        sources.splice(idx, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }

  // 4. Total-bytes cap (on original data). Estimate serialized size; drop lowest-priority first.
  function bytes(arr: EvidenceSource[]): number {
    let n = 0;
    for (const s of arr) {
      n += s.title.length + s.url.length + s.snippet.length + s.query.length + 100;
    }
    return n;
  }
  while (bytes(sources) > EVIDENCE_PACK_LIMITS.MAX_TOTAL_BYTES) {
    budgetExceeded = true;
    let dropped = false;
    for (const g of DROP_PRIORITY) {
      const idx = sources.findIndex(s => s.source === g);
      if (idx >= 0) { sources.splice(idx, 1); dropped = true; break; }
    }
    if (!dropped) break;
  }

  // 5. Truncate snippets to MAX_SNIPPET_CHARS.
  sources = sources.map(s => {
    if (s.snippet.length <= EVIDENCE_PACK_LIMITS.MAX_SNIPPET_CHARS) return s;
    return {
      ...s,
      snippet: s.snippet.slice(0, EVIDENCE_PACK_LIMITS.MAX_SNIPPET_CHARS) + '…',
    };
  });

  return {
    sources,
    failedAttempts: [...failedAttempts],
    generatedAt:    new Date().toISOString(),
    totalQueries:   inputSources.length,
    budgetExceeded,
  };
}

export function serializeEvidencePack(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push(`## Sources (${pack.sources.length})`);
  if (pack.budgetExceeded) {
    lines.push('> _Note: evidence-pack budget was exceeded; some sources were dropped per priority policy._');
  }
  lines.push('');
  for (const s of pack.sources) {
    lines.push(`### [${s.source}] ${s.title}`);
    lines.push(`- URL: ${s.url}`);
    lines.push(`- Query: ${s.query}`);
    if (s.publishedAt) lines.push(`- Published: ${s.publishedAt}`);
    lines.push('');
    lines.push(s.snippet);
    lines.push('');
  }
  if (pack.failedAttempts.length > 0) {
    lines.push('## Sources that failed');
    lines.push('');
    for (const f of pack.failedAttempts) {
      const detail = f.detail ? ` — ${f.detail}` : '';
      lines.push(`- [${f.source}] query="${f.query}" reason=${f.reason}${detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
