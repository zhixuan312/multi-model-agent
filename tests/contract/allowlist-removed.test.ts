import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname polyfill for ESM (the project is "type": "module")
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

describe('allowlist scaffolding removed', () => {
  it('event-builder.ts no longer exports allowlistModel', async () => {
    const mod = await import('../../packages/core/src/telemetry/event-builder.js');
    expect((mod as any).allowlistModel).toBeUndefined();
    expect((mod as any).normalizeModelForTelemetry).toBeDefined();
  });

  it('event-builder.ts source has no ALLOWLISTED_TOOL set', () => {
    const src = readFileSync(join(__dirname, '../../packages/core/src/telemetry/event-builder.ts'), 'utf8');
    expect(src).not.toMatch(/ALLOWLISTED_TOOL/);
  });

  it('types.ts no longer exports KnownModelId or ModelIdOrOther', async () => {
    const mod = await import('../../packages/core/src/telemetry/types.js');
    expect((mod as any).KnownModelId).toBeUndefined();
    expect((mod as any).ModelIdOrOther).toBeUndefined();
    expect((mod as any).BoundedIdentifier).toBeDefined();
  });
});
