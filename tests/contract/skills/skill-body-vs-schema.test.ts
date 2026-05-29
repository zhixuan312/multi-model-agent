import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Static route → schema map. Update when a new route + skill is added.
// Imports are subpath imports of @zhixuan92/multi-model-agent-core; if any of
// these subpaths aren't yet exported in packages/core/package.json's
// "exports" field, ADD them following the pattern in Tasks A1.6 step 5a / A6.2 step 3a.
import { inputSchema as auditSchema } from '@zhixuan92/multi-model-agent-core/tools/audit/schema';
import { inputSchema as reviewSchema } from '@zhixuan92/multi-model-agent-core/tools/review/schema';
import { inputSchema as debugSchema } from '@zhixuan92/multi-model-agent-core/tools/debug/schema';
import { inputSchema as investigateSchema } from '@zhixuan92/multi-model-agent-core/tools/investigate/schema';
import { inputSchema as delegateSchema } from '@zhixuan92/multi-model-agent-core/tools/delegate/schema';
import { executePlanInputSchema } from '@zhixuan92/multi-model-agent-core/tools/execute-plan/tool-config';
import { inputSchema as registerContextBlockSchema } from '@zhixuan92/multi-model-agent-core/tools/register-context-block/schema';
import { inputSchema as retrySchema } from '@zhixuan92/multi-model-agent-core/tools/retry/schema';
import { inputSchema as researchSchema } from '@zhixuan92/multi-model-agent-core/tools/research/schema';
import { inputSchema as journalRecordSchema } from '@zhixuan92/multi-model-agent-core/tools/journal/record/schema';
import { inputSchema as journalRecallSchema } from '@zhixuan92/multi-model-agent-core/tools/journal/recall/schema';

const ROUTE_TO_SCHEMA: Record<string, z.ZodTypeAny> = {
  '/audit': auditSchema,
  '/review': reviewSchema,
  '/debug': debugSchema,
  '/investigate': investigateSchema,
  '/delegate': delegateSchema,
  '/execute-plan': executePlanInputSchema,
  '/context-blocks': registerContextBlockSchema,
  '/retry': retrySchema,
  '/research': researchSchema,
  '/journal-record': journalRecordSchema,
  '/journal-recall': journalRecallSchema,
};

/**
 * Extract the FIRST ```json fenced block under a heading whose text starts
 * with "Request body" (case-insensitive). Returns the parsed JSON value.
 * Throws "No '## Request body' section found" when absent — caller skips.
 */
function extractRequestBodyJson(skillMarkdown: string): unknown {
  // Section spans from `## Request body` heading to the next `## ` heading
  // (or end of file). We do NOT use the `m` flag because `$` in multiline
  // mode matches end-of-line, which truncates the capture at the first
  // blank line right after the heading. Without `m`, `$` is end-of-string
  // and the capture grows until the next `## ` heading. (Plan A5.1 step 1
  // had the buggy `m` form; fixed inline.)
  const headerMatch = skillMarkdown.match(/(?:^|\n)##\s+Request body\b[^\n]*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!headerMatch) throw new Error('No "## Request body" section found');
  const blockMatch = headerMatch[1].match(/```json\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) throw new Error('No ```json``` block under "## Request body"');
  return JSON.parse(blockMatch[1]);
}

/**
 * Extract the route path from the Endpoint section, e.g. "POST /audit?cwd=..."
 * → "/audit".
 */
function extractRouteName(skillMarkdown: string): string {
  const headerMatch = skillMarkdown.match(/(?:^|\n)##\s+Endpoint\b[^\n]*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (!headerMatch) throw new Error('No "## Endpoint" section found');
  const routeMatch = headerMatch[1].match(/`?POST\s+(\/[a-z0-9-_/]+?)(?:\?|`|\s|$)/i);
  if (!routeMatch) throw new Error('No POST route found in "## Endpoint"');
  return routeMatch[1];
}

const skillsDir = resolve(import.meta.dirname, '../../../packages/server/src/skills');
const skills = readdirSync(skillsDir).filter(d => d.startsWith('mma-'));

describe('SKILL.md request-body examples match route Zod schemas', () => {
  for (const skill of skills) {
    it(`${skill} request body parses against its route schema`, () => {
      const skillBody = readFileSync(resolve(skillsDir, skill, 'SKILL.md'), 'utf8');

      // Skip wrapper / orchestrator skills with no HTTP route. They
      // either omit the "## Request body" heading entirely OR include
      // the heading with a "(Not applicable …)" note instead of a json
      // block (mma-explore is the canonical example).
      let example: unknown;
      try {
        example = extractRequestBodyJson(skillBody);
      } catch (err) {
        if (
          err instanceof Error
          && (err.message.startsWith('No "## Request body" section')
              || err.message.startsWith('No ```json``` block under "## Request body"'))
        ) {
          // eslint-disable-next-line no-console
          console.log(`skipping ${skill}: no request body (wrapper skill)`);
          return;
        }
        throw err;
      }

      const routeName = extractRouteName(skillBody);
      const schema = ROUTE_TO_SCHEMA[routeName];
      if (!schema) throw new Error(`No schema mapped for route ${routeName} in ROUTE_TO_SCHEMA — update tests/contract/skills/skill-body-vs-schema.test.ts to add the mapping`);
      const result = schema.safeParse(example);
      expect(result.success, `${skill}: parse error ${JSON.stringify(result.error?.issues)}`).toBe(true);
    });
  }
});
