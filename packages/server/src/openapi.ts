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
import * as delegate from '@zhixuan92/multi-model-agent-core/tool-schemas/delegate';
import * as audit from '@zhixuan92/multi-model-agent-core/tool-schemas/audit';
import * as review from '@zhixuan92/multi-model-agent-core/tool-schemas/review';
import * as verify from '@zhixuan92/multi-model-agent-core/tool-schemas/verify';
import * as debug from '@zhixuan92/multi-model-agent-core/tool-schemas/debug';
import * as executePlan from '@zhixuan92/multi-model-agent-core/tool-schemas/execute-plan';
import * as retry from '@zhixuan92/multi-model-agent-core/tool-schemas/retry';
import * as investigate from '@zhixuan92/multi-model-agent-core/tool-schemas/investigate';

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
      200: { description: 'Batch state (pending | awaiting_clarification | complete | failed | expired)' },
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

  registry.registerPath({
    method: 'post',
    path: '/clarifications/confirm',
    summary: 'Confirm a proposed interpretation to unblock an awaiting_clarification batch',
    tags: ['Control'],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              batchId: z.string(),
              interpretation: z.string(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Clarification accepted' },
      400: { description: 'Invalid batch state' },
      401: response401,
      404: response404,
    },
  });

  // ── Introspection endpoints ─────────────────────────────────────────────────

  registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Liveness probe — no auth required',
    tags: ['Introspection'],
    responses: {
      200: {
        description: 'Server is alive',
        content: {
          'application/json': {
            schema: z.object({ ok: z.literal(true) }),
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
      version: '3.0.0',
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
