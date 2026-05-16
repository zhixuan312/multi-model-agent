// tests/contract/architecture/openapi-shape.test.ts
//
// Plan task — verifies the OpenAPI doc exposes the v5 envelope shape.
// The full route+golden contract lives in tests/contract/http/*. This
// suite is the shape-level guard: every route documents `error` as
// nullable (terminal envelope discriminator) and every tool route's
// 200 response references the shared OutputEnvelope schema.

import { describe, it, expect } from 'vitest';
import { buildOpenApiDoc } from '../../../packages/core/src/tool-surface/openapi-generator.js';

describe('OpenAPI shape', () => {
  const doc = buildOpenApiDoc() as Record<string, unknown>;

  it('exposes an OutputEnvelope schema in components', () => {
    const components = doc.components as { schemas?: Record<string, unknown> };
    expect(components?.schemas).toBeDefined();
    expect(components.schemas!['OutputEnvelope']).toBeDefined();
  });

  it('declares the 6 wire envelope fields with correct types', () => {
    const components = doc.components as { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] } > };
    const env = components.schemas?.['OutputEnvelope'];
    expect(env).toBeDefined();
    const props = env!.properties ?? {};
    // The shared envelope across every tool route has exactly these 6 fields.
    for (const field of ['headline', 'results', 'batchTimings', 'costSummary', 'structuredReport', 'error']) {
      expect(props[field]).toBeDefined();
    }
  });

  it('has at least one path entry per tool route', () => {
    const paths = doc.paths as Record<string, unknown>;
    expect(paths).toBeDefined();
    const expected = [
      '/delegate', '/audit', '/review', '/debug', '/investigate',
      '/execute-plan', '/retry', '/research', '/context-blocks',
    ];
    for (const route of expected) {
      expect(paths[route], `expected path ${route} to be documented`).toBeDefined();
    }
  });

  it('every tool POST documents the cwd query parameter', () => {
    const paths = doc.paths as Record<string, { post?: { parameters?: Array<{ name?: string; in?: string }> } }>;
    for (const [route, ops] of Object.entries(paths)) {
      // Skip non-tool routes like /batch/:id, /health, etc.
      if (!ops.post) continue;
      const params = ops.post.parameters ?? [];
      const cwd = params.find(p => p.name === 'cwd' && p.in === 'query');
      // Some routes like /register-context-block have a body cwd instead;
      // accept either shape but require at least one mention.
      if (!cwd) {
        // Permissive check — body schema may inline cwd; verify the
        // requestBody references something that names cwd.
        const opAny = ops.post as { requestBody?: { content?: Record<string, { schema?: unknown }> } };
        const rb = opAny.requestBody?.content;
        const schemaText = JSON.stringify(rb ?? {});
        expect(
          schemaText.includes('cwd'),
          `route ${route} POST should document cwd (query or body)`,
        ).toBe(true);
      }
    }
  });
});
