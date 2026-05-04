import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BatchPersister {
  persist(batchId: string, state: unknown, baseDir: string): string {
    const path = `${baseDir}/${batchId}.json`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
    return path;
  }
}
