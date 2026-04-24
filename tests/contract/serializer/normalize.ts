// Normalized serializer for contract goldens. Replaces volatile fields
// (timings, batch IDs, timestamps) with a DETERMINISTIC sentinel so golden
// comparison is stable across runs, and rewrites absolute repo paths to a
// repo-relative form.

const DET = '<DETERMINISTIC>';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

const VOLATILE_KEYS = new Set([
  'wallClockMs',
  'sumOfTaskMs',
  'estimatedParallelSavingsMs',
  'durationMs',
  'uptimeMs',
  'startedAt',
  'finishedAt',
  'timestamp',
  'batchId',
  'pid',
]);

const PATH_LIKE_KEYS = new Set(['path', 'cwd', 'filePath', 'file']);

export function normalize(value: JsonValue, repoRoot: string = process.cwd()): JsonValue {
  if (Array.isArray(value)) return value.map((v) => normalize(v, repoRoot));
  if (value && typeof value === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) {
        out[k] = DET;
        continue;
      }
      if (PATH_LIKE_KEYS.has(k) && typeof v === 'string' && v.startsWith(repoRoot)) {
        out[k] = `<REPO>${v.slice(repoRoot.length)}`;
        continue;
      }
      out[k] = normalize(v, repoRoot);
    }
    return out;
  }
  return value;
}
