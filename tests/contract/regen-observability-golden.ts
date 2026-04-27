// NOTE: this script reaches into Zod's internal `_def` / `.options` / `.shape` surfaces.
// These are stable in Zod 3.x but coupled to internal structure — re-verify on Zod major
// version bumps. See https://zod.dev for the current public API.

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, type ZodObject } from 'zod';
import { Event } from '../../packages/core/src/observability/events.js';

interface ManifestEntry {
  name: string;
  requiredFields: string[];
}

function flattenShape(shape: Record<string, z.ZodTypeAny>, prefix = ''): string[] {
  const fields: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const inner = schema instanceof z.ZodOptional ? schema._def.innerType
                : schema instanceof z.ZodNullable ? schema._def.innerType
                : schema;
    if (inner instanceof z.ZodObject) {
      fields.push(...flattenShape(inner.shape as Record<string, z.ZodTypeAny>, prefix + key + '.'));
    } else if (!(schema instanceof z.ZodOptional)) {
      fields.push(prefix + key);
    }
  }
  return fields;
}

const manifest: ManifestEntry[] = [];
for (const member of (Event as any)._def.options as ZodObject<any>[]) {
  const shape = member.shape as Record<string, z.ZodTypeAny>;
  const literalValue = (shape.event as z.ZodLiteral<string>).value;
  const eventName = literalValue as string;
  manifest.push({
    name: eventName,
    requiredFields: ['event', ...flattenShape(shape).filter(f => f !== 'event')],
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, 'goldens', 'observability.json');
writeFileSync(out, JSON.stringify({ events: manifest }, null, 2) + '\n');
