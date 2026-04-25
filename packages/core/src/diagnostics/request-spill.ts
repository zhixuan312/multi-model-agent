import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SpillInput {
  dir: string;
  batch: string;
  body: unknown;
}

export interface SpillResult {
  path: string;
  bytes: number;
}

/**
 * Spill a request body to <dir>/<batch>.json with private file permissions.
 * If the file already exists, it is overwritten; registry-minted batch IDs are
 * unique per batch, so collisions are expected only for same-batch duplicate logs.
 */
export async function spillRequestBody(input: SpillInput): Promise<SpillResult> {
  if (!UUID_RE.test(input.batch)) {
    // Path-traversal guard: batch must be a UUID (registry-minted).
    throw new Error(`spillRequestBody: batch must be a UUID, got: ${input.batch}`);
  }

  await mkdir(input.dir, { recursive: true });
  const path = join(input.dir, `${input.batch}.json`);
  const json = JSON.stringify(input.body);
  const bytes = Buffer.byteLength(json, 'utf8');
  await writeFile(path, json, { mode: 0o600 });
  // Belt-and-suspenders: explicitly chmod in case file pre-existed with wider mode.
  await chmod(path, 0o600);
  return { path, bytes };
}
