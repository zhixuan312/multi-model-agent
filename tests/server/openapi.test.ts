// tests/server/openapi.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../helpers/test-server.js';
import { buildOpenApiDoc, serializeOpenApiDoc } from '../../packages/server/src/openapi.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(
  thisDir,
  '../../packages/server/src/__fixtures__/openapi.golden.json',
);

describe('OpenAPI document', () => {
  it('GET /tools returns 200 application/json with valid OpenAPI 3 structure', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/tools`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json() as Record<string, unknown>;

      // Must have the OpenAPI version field
      expect(typeof body['openapi']).toBe('string');
      expect((body['openapi'] as string).startsWith('3.')).toBe(true);

      // Must have info and paths
      expect(body).toHaveProperty('info');
      expect(body).toHaveProperty('paths');

      const info = body['info'] as Record<string, unknown>;
      expect(info).toHaveProperty('title');
      expect(info).toHaveProperty('version');
    } finally {
      await s.stop();
    }
  });

  it('GET /tools requires bearer auth (401 without token)', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/tools`);
      expect(res.status).toBe(401);
    } finally {
      await s.stop();
    }
  });

  it('generated doc matches committed golden snapshot', () => {
    const doc = buildOpenApiDoc();
    const serialized = serializeOpenApiDoc(doc);

    if (!existsSync(GOLDEN_PATH)) {
      // Bootstrap: write the golden file on first run
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, serialized, 'utf8');
      // Pass on first run — the file has just been created
      return;
    }

    const golden = readFileSync(GOLDEN_PATH, 'utf8');

    // Compare as parsed objects to avoid whitespace / line-ending differences
    expect(JSON.parse(serialized)).toEqual(JSON.parse(golden));
  });

  it('document covers all 7 tool endpoints and 4 control + 2 introspection routes', () => {
    const doc = buildOpenApiDoc();
    const paths = Object.keys(doc['paths'] as Record<string, unknown>);

    // 7 tool routes
    expect(paths).toContain('/delegate');
    expect(paths).toContain('/audit');
    expect(paths).toContain('/review');
    expect(paths).toContain('/verify');
    expect(paths).toContain('/debug');
    expect(paths).toContain('/execute-plan');
    expect(paths).toContain('/retry');

    // 4 control routes
    expect(paths).toContain('/batch/{batchId}');
    expect(paths).toContain('/context-blocks');
    expect(paths).toContain('/context-blocks/{blockId}');
    expect(paths).toContain('/clarifications/confirm');

    // 2 introspection routes
    expect(paths).toContain('/health');
    expect(paths).toContain('/status');

    // Total: 14 paths
    expect(paths.length).toBe(14);
  });
});
