import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const coreSrc = resolve(repoRoot, 'packages/core/src');
const goldenPath = resolve(here, '../goldens/architecture/c-tier-folders.json');

describe('contract: C-tier folder inventory', () => {
  it('packages/core/src/ folder list matches the architecture golden', () => {
    const actual = readdirSync(coreSrc, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { folders: string[] };
    expect(actual).toEqual(golden.folders);
  });
});
