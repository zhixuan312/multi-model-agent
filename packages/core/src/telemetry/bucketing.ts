export type CostBucket       = '$0' | '<$0.01' | '$0.01-$0.10' | '$0.10-$1' | '$1+';
export type SavedCostBucket  = '$0' | '<$0.10' | '$0.10-$1' | '$1+' | 'unknown';
export type DurationBucket   = '<10s' | '10s-1m' | '1m-5m' | '5m-30m' | '30m+';
export type FileCountBucket  = '0' | '1-5' | '6-20' | '21-50' | '51+';
export type RoundsUsedBucket = '0' | '1' | '2+';

export function bucketCost(usd: number): CostBucket {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd <  0.01)   return '<$0.01';
  if (usd <  0.10)   return '$0.01-$0.10';
  if (usd <  1)      return '$0.10-$1';
  return '$1+';
}

export function bucketSavedCost(usd: number | null): SavedCostBucket {
  if (usd === null)  return 'unknown';
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd <  0.10)   return '<$0.10';
  if (usd <  1)      return '$0.10-$1';
  return '$1+';
}

export function bucketDuration(ms: number): DurationBucket {
  if (ms <    10_000)  return '<10s';
  if (ms <    60_000)  return '10s-1m';
  if (ms <   300_000)  return '1m-5m';
  if (ms < 1_800_000)  return '5m-30m';
  return '30m+';
}

export function bucketFileCount(n: number): FileCountBucket {
  if (n === 0) return '0';
  if (n <  6)  return '1-5';
  if (n < 21)  return '6-20';
  if (n < 51)  return '21-50';
  return '51+';
}

export type TurnCountBucket = '1-3' | '4-10' | '11-30' | '31+';

export function bucketTurnCount(n: number): TurnCountBucket {
  if (n <  4)  return '1-3';
  if (n < 11)  return '4-10';
  if (n < 31)  return '11-30';
  return '31+';
}

export function bucketRoundsUsed(rounds: number): RoundsUsedBucket {
  if (rounds === 0) return '0';
  if (rounds === 1) return '1';
  return '2+';
}
