import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import * as deliveryPackagers from '../../packages/core/src/initiative-record/delivery-packagers.js';

const ASSETS = [
  { id: 'runnable-prototype@1', directory: 'runnable-prototype' },
  { id: 'runnable-software@1', directory: 'runnable-software' },
];

type ResolveFromRoot = (id: string, root: string, assets?: readonly { id: string; directory: string }[]) => string;
const resolveFromRoot = (deliveryPackagers as { resolveDeliveryPackagerFromRootForTest?: ResolveFromRoot })
  .resolveDeliveryPackagerFromRootForTest;

function createAssetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mma-delivery-packagers-'));
  for (const asset of ASSETS) {
    const directory = join(root, asset.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'packager.md'), asset.id, 'utf8');
  }
  return root;
}

describe('Delivery packager resolver supplemental error paths', () => {
  it('rejects every declared source-tree integrity failure', () => {
    expect(resolveFromRoot).toBeTypeOf('function');

    const root = createAssetRoot();
    try {
      expect(() => resolveFromRoot!('not-a-real-contract@1', root)).toThrow(/unknown_delivery_contract/);
      expect(() => resolveFromRoot!('runnable-prototype@1', join(root, 'missing'))).toThrow(/no committed packager assets directory/);

      mkdirSync(join(root, 'orphan'));
      expect(() => resolveFromRoot!('runnable-prototype@1', root)).toThrow(/orphan committed packager asset/);
      rmSync(join(root, 'orphan'), { recursive: true, force: true });

      unlinkSync(join(root, 'runnable-software', 'packager.md'));
      mkdirSync(join(root, 'runnable-software', 'packager.md'));
      expect(() => resolveFromRoot!('runnable-software@1', root)).toThrow(/no committed packager asset/);
      rmSync(join(root, 'runnable-software', 'packager.md'), { recursive: true, force: true });
      writeFileSync(join(root, 'runnable-software', 'packager.md'), 'runnable-software@1', 'utf8');

      expect(() => resolveFromRoot!('runnable-prototype@1', root, [
        ASSETS[0]!,
        { id: 'runnable-software@1', directory: 'runnable-prototype' },
      ])).toThrow(/duplicate committed packager mapping/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
