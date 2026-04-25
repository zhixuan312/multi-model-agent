// Pins the generated OpenAPI document. Ch 7 Task 41 made openapi.ts
// table-driven; this test catches any future drift from the documented
// HTTP surface. The golden lives at tests/contract/goldens/openapi.json
// and is captured on first run; subsequent runs diff byte-for-byte.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDoc, serializeOpenApiDoc } from '../../../packages/server/src/openapi.js';

describe('contract: openapi schema', () => {
  const goldenPath = resolve('tests/contract/goldens/openapi.json');

  it('matches the committed golden byte-for-byte', () => {
    const doc = buildOpenApiDoc();
    const actual = serializeOpenApiDoc(doc);

    if (!existsSync(goldenPath) || process.env['CAPTURE_OPENAPI_GOLDEN'] === '1') {
      writeFileSync(goldenPath, actual + '\n', 'utf8');
      // eslint-disable-next-line no-console
      console.log(`captured openapi golden at ${goldenPath}`);
      return;
    }

    const expected = readFileSync(goldenPath, 'utf8').replace(/\n$/, '');
    expect(actual).toBe(expected);
  });
});
