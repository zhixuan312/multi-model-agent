import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function createTempProject(): { cwd: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}
