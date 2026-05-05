export function bucketFilesWritten(count: number): '0' | '1-5' | '6-20' | '21-50' | '51+' {
  if (count === 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  if (count <= 50) return '21-50';
  return '51+';
}

export function bucketTurnCount(count: number): '1-3' | '4-10' | '11-30' | '31+' {
  if (count <= 3) return '1-3';
  if (count <= 10) return '4-10';
  if (count <= 30) return '11-30';
  return '31+';
}
