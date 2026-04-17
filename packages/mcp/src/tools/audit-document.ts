import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  validateInput,
  resolveDispatchMode,
  buildMetadataBlock,
  buildFilePathsPrompt,
  buildPerFilePrompt,
} from './shared.js';
import { buildFanOutResponse } from './batch-response.js';

export const auditDocumentSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.union([
    z.enum(['security', 'performance', 'correctness', 'style', 'general']),
    z.array(z.enum(['security', 'performance', 'correctness', 'style'])).min(1),
  ]).describe('Audit focus.'),
  ...commonToolFields,
});

export type AuditDocumentParams = z.infer<typeof auditDocumentSchema>;

function resolveAuditTypeText(auditType: AuditDocumentParams['auditType']): string {
  if (auditType === 'general') return 'security, performance, correctness, and style';
  if (Array.isArray(auditType)) return auditType.join(', ');
  return auditType;
}

const AUDIT_DONE_CONDITIONS: Record<string, string> = {
  security: 'Identify all security vulnerabilities (injection, auth bypass, data exposure, OWASP top 10). Each finding has severity (critical/high/medium/low), location, and remediation.',
  performance: 'Identify all performance issues (O(n²) loops, unnecessary allocations, missing caching, blocking I/O). Each finding has impact level, location, and fix recommendation.',
  correctness: 'Identify all logic errors, off-by-one bugs, unhandled edge cases, type mismatches, and contract violations. Each finding has severity, location, and correct behavior.',
  style: 'Identify all style issues (naming, formatting, dead code, inconsistent patterns). Each finding has location and recommended fix.',
  general: 'Identify issues across security, performance, correctness, and style. Each finding has category, severity, location, and remediation.',
};

function resolveAuditDoneCondition(auditType: AuditDocumentParams['auditType']): string {
  if (auditType === 'general') return AUDIT_DONE_CONDITIONS.general;
  if (Array.isArray(auditType)) {
    return auditType.map(t => AUDIT_DONE_CONDITIONS[t]).join(' ');
  }
  return AUDIT_DONE_CONDITIONS[auditType] ?? AUDIT_DONE_CONDITIONS.general;
}

function buildAuditPrompt(
  auditTypeText: string,
  document: string | undefined,
  filePaths: string[] | undefined,
): string {
  const parts: string[] = [`Audit for ${auditTypeText} issues.`];
  if (document) parts.push(`Document:\n\n${document}`);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  parts.push('Provide a structured audit report with findings and severity.');
  return parts.join('\n\n');
}

export function registerAuditDocument(server: McpServer, config: MultiModelConfig) {
  server.tool(
    'audit_document',
    'Audit documents for issues. Accepts inline content or file paths (multiple files audit in parallel). Preset: complex agent, no review. Use delegate_tasks only for custom config.',
    auditDocumentSchema.shape,
    async (params: AuditDocumentParams) => {
      const validation = validateInput(params.document, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const baseTaskSpec: Partial<TaskSpec> = {
        agentType: 'complex',
        reviewPolicy: 'off',
        briefQualityPolicy: 'off',
        done: resolveAuditDoneCondition(params.auditType),
        tools: config.defaults?.tools ?? 'full',
        timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
        maxCostUSD: config.defaults?.maxCostUSD ?? 10,
        sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
        cwd: process.cwd(),
      };

      try {
        const mode = resolveDispatchMode(params.document, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const auditTypeText = resolveAuditTypeText(params.auditType);
          const promptTemplate = buildAuditPrompt(auditTypeText, undefined, undefined);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config);
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        // Single-task mode
        const auditTypeText = resolveAuditTypeText(params.auditType);
        const prompt = buildAuditPrompt(auditTypeText, params.document, params.filePaths);
        const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config);
        const result = results[0];
        return { content: [{ type: 'text' as const, text: result.output }, buildMetadataBlock(result)] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
