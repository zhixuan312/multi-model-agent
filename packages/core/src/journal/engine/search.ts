import type { CorpusAdapter, RankedList, StoredRecord } from './types.js';
import type { CorpusIndex } from './index-store.js';

/** Reciprocal Rank Fusion constant. Standard RRF damping. */
const RRF_K = 60;

/** RRF contribution for a 1-based rank position. */
function rrf(rank1Based: number): number {
  return 1 / (RRF_K + rank1Based);
}

/**
 * Fuse the engine's own lexical (FTS5/BM25) ranking with zero or more
 * adapter-supplied ranked signal lists via Reciprocal Rank Fusion (k=60), then
 * resolve the fused ids back to full records, best-first.
 *
 * `pool`, when given, restricts both the lexical signal and the candidate set
 * to those ids; when omitted every indexed record is eligible. Only records
 * that appear in at least one ranked list are returned — a pool member no
 * signal ever ranked contributes nothing and is omitted, exactly as the
 * original fused ranking behaved.
 */
export async function rrfSearch(
  index: CorpusIndex,
  adapter: CorpusAdapter,
  tokens: string[],
  pool?: string[],
): Promise<StoredRecord[]> {
  // Ranking needs ids plus adapter-owned metadata, not record text.  Keep
  // whole-corpus body materialization out of the hot path, then fetch full
  // rows only for the fused ids that will be returned.
  const all = index.allRecordsMeta();
  const poolIds = pool ? new Set(pool) : new Set(all.map((record) => record.id));
  const scoped = all.filter((record) => poolIds.has(record.id));
  const byId = new Map(scoped.map((record) => [record.id, record]));

  const lexicalOrder = index
    .lexicalSearch(tokens)
    .map((hit) => hit.id)
    .filter((id) => poolIds.has(id));

  const signalLists = await adapter.signals(tokens, scoped, lexicalOrder);
  const lists: RankedList[] = [{ via: 'lexical', order: lexicalOrder }, ...signalLists];

  const fused = new Map<string, number>();
  for (const list of lists) {
    list.order.forEach((id, position) => {
      if (!byId.has(id)) return; // ignore ids outside the current pool
      fused.set(id, (fused.get(id) ?? 0) + rrf(position + 1));
    });
  }

  const rankedIds = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  const recordsById = new Map(index.recordsByIds(rankedIds).map((record) => [record.id, record]));
  return rankedIds.flatMap((id) => {
    const record = recordsById.get(id);
    return record ? [record] : [];
  });
}
