// packages/server/src/openapi.ts
//
// Builds the OpenAPI 3.0 document that describes all endpoints of the
// multi-model-agent HTTP server.
//
// Uses @asteasolutions/zod-to-openapi to convert each tool's Zod inputSchema
// directly into OpenAPI request body schemas.
import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import * as delegate from '../tools/delegate/schema.js';
import * as audit from '../tools/audit/schema.js';
import * as review from '../tools/review/schema.js';
import * as verify from '../tools/verify/schema.js';
import * as debug from '../tools/debug/schema.js';
import * as executePlan from '../tools/execute-plan/schema.js';
import * as retry from '../tools/retry/schema.js';
import * as investigate from '../tools/investigate/schema.js';
import * as research from '../tools/research/schema.js';


// Extend Zod once with openapi support.
extendZodWithOpenApi(z);

/** Sort an object's keys recursively for deterministic JSON serialization. */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ── v4.0 component schemas ───────────────────────────────────────────────────

/** 4-field token usage shape (v4.0). */
const tokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0).describe('Prompt/input tokens consumed'),
  outputTokens: z.number().int().min(0).describe('Completion/output tokens produced'),
  cachedReadTokens: z.number().int().min(0).describe('Input tokens served from cache read'),
  cachedNonReadTokens: z.number().int().min(0).describe('Input tokens written to cache but not read'),
});

/** v4.0 output envelope (terminal response shape). */
const outputEnvelopeSchema = z.object({
  headline: z.string().min(1).describe('One-line summary of the outcome'),
  results: z.array(z.unknown()).describe('Per-task result items'),
  batchTimings: z.object({}).passthrough().describe('Wall-clock and per-phase timings'),
  costSummary: z.object({
    totalCostUSD: z.number().min(0).describe('Total estimated cost in USD'),
    tokenUsage: tokenUsageSchema.describe('Aggregated token consumption'),
  }).passthrough().describe('Cost and token metering summary'),
  structuredReport: z.object({}).passthrough().describe('Structured report object (tool-specific schema)'),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }).optional().describe('Terminal error if the batch failed'),
  annotatorConfidence: z.number().min(0).max(1).optional()
    .describe('Annotator confidence score (0-1) when the review policy produced annotations'),
  specReviewVerdict: z.enum(['approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable']).optional(),
  qualityReviewVerdict: z.enum(['approved', 'concerns', 'changes_required', 'annotated', 'error', 'skipped', 'not_applicable']).optional(),
  roundsUsed: z.number().int().min(0).optional().describe('Number of agent rounds consumed'),
  blockId: z.string().optional().describe('Terminal context block id registered automatically for this task'),
}).passthrough();

/** Shared 202 response for async tool endpoints. */
const asyncResponse202 = {
  description: 'Accepted — batch created',
  content: {
    'application/json': {
      schema: z.object({
        batchId: z.string().describe('Unique batch identifier for polling via GET /batch/:batchId'),
        statusUrl: z.string().describe('Full URL to poll for this batch'),
      }),
    },
  },
};

/** Shared `cwd` query parameter (required by all tool endpoints). */
const cwdQueryParam = {
  name: 'cwd',
  in: 'query' as const,
  required: true,
  description: 'Absolute path to the project working directory',
  schema: { type: 'string' as const },
};

/** Standard 401 error response. */
const response401 = { description: 'Missing or invalid Bearer token' };

/** Standard 403 error response. */
const response403 = { description: 'Forbidden (loopback-only or path traversal)' };

/** Standard 404 error response. */
const response404 = { description: 'Resource not found' };

// Tool-endpoint registration table. Each row contributes one path with the
// shared shape: POST /<path>?cwd=<abs>, JSON body, async 202 response.
const TOOL_ENDPOINTS: Array<{ path: string; summary: string; schema: z.ZodTypeAny }> = [
  { path: '/delegate', summary: 'Dispatch tasks to sub-agents', schema: delegate.inputSchema },
  { path: '/audit', summary: 'Audit documents or files', schema: audit.inputSchema },
  { path: '/review', summary: 'Review code for quality and security', schema: review.inputSchema },
  { path: '/verify', summary: 'Verify work against a checklist', schema: verify.inputSchema },
  { path: '/debug', summary: 'Debug a problem with sub-agent assistance', schema: debug.inputSchema },
  { path: '/execute-plan', summary: 'Execute tasks from a plan file', schema: executePlan.inputSchema },
  { path: '/retry', summary: 'Retry failed tasks from a previous batch', schema: retry.inputSchema },
  {
    path: '/investigate',
    summary: 'Investigate the codebase and answer a question with structured citations',
    schema: investigate.inputSchema,
  },
  {
    path: '/research',
    summary: 'External multi-source research with citations (arxiv, semantic_scholar, github_search, rss, brave-with-site:-filters)',
    schema: research.inputSchema,
  },
];

function registerToolEndpoint(
  registry: OpenAPIRegistry,
  row: { path: string; summary: string; schema: z.ZodTypeAny },
): void {
  registry.registerPath({
    method: 'post',
    path: row.path,
    summary: row.summary,
    tags: ['Tools'],
    request: {
      query: z.object({ cwd: z.string().describe('Project working directory') }),
      body: {
        required: true,
        content: { 'application/json': { schema: row.schema } },
      },
    },
    responses: {
      202: asyncResponse202,
      400: { description: 'Request validation error' },
      401: response401,
    },
  });
}

export function buildOpenApiDoc(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();

  // ── Component schemas ───────────────────────────────────────────────────────
  registry.register('TokenUsage', tokenUsageSchema);
  registry.register('OutputEnvelope', outputEnvelopeSchema);

  // ── Tool endpoints (POST, require cwd + auth) ───────────────────────────────
  for (const row of TOOL_ENDPOINTS) registerToolEndpoint(registry, row);

  // ── Control endpoints ───────────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/batch/{batchId}',
    summary: 'Poll batch status',
    tags: ['Control'],
    request: {
      params: z.object({ batchId: z.string().describe('Batch identifier') }),
      query: z.object({
        taskIndex: z.string().optional().describe('Zero-based task index for result slicing'),
      }),
    },
    responses: {
      200: {
        description: 'Batch state — pending returns { status: "pending" }; complete returns the OutputEnvelope; failed returns OutputEnvelope with error; expired returns { status: "expired" }',
        content: {
          'application/json': {
            schema: z.union([
              z.object({ status: z.enum(['pending', 'expired']) }),
              outputEnvelopeSchema,
            ]),
          },
        },
      },
      401: response401,
      404: response404,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/context-blocks',
    summary: 'Register a context block',
    tags: ['Control'],
    request: {
      query: z.object({ cwd: z.string().describe('Project working directory') }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              content: z.string().describe('Block content (plain text or markdown)'),
              label: z.string().optional().describe('Human-readable label'),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Block created' },
      400: { description: 'Validation error or content too large' },
      401: response401,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/context-blocks/{blockId}',
    summary: 'Delete a context block',
    tags: ['Control'],
    request: {
      params: z.object({ blockId: z.string().describe('Context block identifier') }),
      query: z.object({ cwd: z.string().describe('Project working directory') }),
    },
    responses: {
      200: { description: 'Block deleted (or was already absent)' },
      401: response401,
    },
  });

  // ── Introspection endpoints ─────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness + skill manifest drift check — no auth required',
    tags: ['Introspection'],
    responses: {
      200: {
        description: 'Server is alive; status=ok when all installed skills match the manifest, status=drift when one or more skills are missing, outdated, or orphaned',
        content: {
          'application/json': {
            schema: z.union([
              z.object({ status: z.literal('ok') }),
              z.object({
                status: z.literal('drift'),
                drift: z.array(z.object({
                  skill: z.string(),
                  client: z.string(),
                  issue: z.enum(['missing', 'outdated', 'orphan']),
                })),
              }),
            ]),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/status',
    summary: 'Operator status — loopback + auth required',
    tags: ['Introspection'],
    responses: {
      200: { description: 'Server status object (§5.10)' },
      401: response401,
      403: response403,
    },
  });

  // ── Generate ────────────────────────────────────────────────────────────────

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'multi-model-agent',
      version: '4.0.0',
    },
  });

  // Return a key-sorted version for deterministic golden comparisons
  return sortKeys(doc) as Record<string, unknown>;
}

/** Utility: serialize the OpenAPI doc with sorted keys for golden snapshots. */
export function serializeOpenApiDoc(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2);
}

// Re-export cwdQueryParam for tests / external use
export { cwdQueryParam };
