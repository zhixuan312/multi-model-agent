import { existsSync, statSync } from 'node:fs';

export function fileArtifactExists(path: string): boolean {
  if (!existsSync(path)) return false;
  const s = statSync(path);
  return s.isFile() && s.size > 0;
}
