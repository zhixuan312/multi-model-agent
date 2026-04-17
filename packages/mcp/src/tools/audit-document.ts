import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MultiModelConfig, TaskSpec, ContextBlockStore } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  commonToolFields,
  validateInput,
  resolveDispatchMode,
  buildMetadataBlock,
  buildFilePathsPrompt,
  buildPerFilePrompt,
  buildRunTasksOptions,
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

const DELTA_AUDIT_SUFFIX = ' Perform a full audit (do not reduce thoroughness). Verify each prior finding as fixed or unfixed. Omit fixed prior findings from the main report. Include unfixed prior findings and new findings. End with a summary of which prior findings were resolved.';

function resolveAuditDoneCondition(auditType: AuditDocumentParams['auditType'], hasContextBlocks: boolean): string {
  let base: string;
  if (auditType === 'general') {
    base = AUDIT_DONE_CONDITIONS.general;
  } else if (Array.isArray(auditType)) {
    base = auditType.map(t => AUDIT_DONE_CONDITIONS[t]).join(' ');
  } else {
    base = AUDIT_DONE_CONDITIONS[auditType] ?? AUDIT_DONE_CONDITIONS.general;
  }
  return hasContextBlocks ? base + DELTA_AUDIT_SUFFIX : base;
}

function buildAuditPrompt(
  auditTypeText: string,
  document: string | undefined,
  filePaths: string[] | undefined,
  hasContextBlocks: boolean,
): string {
  const parts: string[] = [`Audit for ${auditTypeText} issues.`];
  if (document) parts.push(`Document:\n\n${document}`);
  const fileSection = buildFilePathsPrompt(filePaths);
  if (fileSection) parts.push(fileSection);
  if (hasContextBlocks) {
    parts.push(
      'A prior audit report is provided as context above.',
      'First, verify which prior findings have been fixed. Then perform a full audit as normal — do not skip areas or reduce thoroughness.',
      'In your output:',
      '- **Omit** prior findings that have been fixed — do not re-report them.',
      '- **Include** prior findings that are still present (mark as "unfixed from prior audit").',
      '- **Include** any new findings not in the prior report.',
      '- End with a **Fixed** summary listing which prior findings were resolved.',
    );
  } else {
    parts.push('Provide a structured audit report with findings and severity.');
  }
  return parts.join('\n\n');
}

export function registerAuditDocument(server: McpServer, config: MultiModelConfig, contextBlockStore?: ContextBlockStore) {
  server.tool(
    'audit_document',
    'Audit documents for issues. Accepts inline content or file paths (multiple files audit in parallel). Preset: complex agent, no review. For delta audits (round 2+), register the prior audit report as a context block and pass its id in contextBlockIds — the tool automatically switches to delta mode, reporting only new findings, unfixed findings, and confirming fixes.',
    auditDocumentSchema.shape,
    async (params: AuditDocumentParams, extra) => {
      const runOptions = buildRunTasksOptions(extra);
      const validation = validateInput(params.document, params.filePaths);
      if (!validation.valid) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.message}` }], isError: true };
      }

      const hasContextBlocks = Array.isArray(params.contextBlockIds) && params.contextBlockIds.length > 0;

      const baseTaskSpec: Partial<TaskSpec> = {
        agentType: 'complex',
        reviewPolicy: 'off',
        briefQualityPolicy: 'off',
        done: resolveAuditDoneCondition(params.auditType, hasContextBlocks),
        tools: config.defaults?.tools ?? 'full',
        timeoutMs: config.defaults?.timeoutMs ?? 1_800_000,
        maxCostUSD: config.defaults?.maxCostUSD ?? 10,
        sandboxPolicy: config.defaults?.sandboxPolicy ?? 'cwd-only',
        cwd: process.cwd(),
        contextBlockIds: params.contextBlockIds,
      };
      const runtime = contextBlockStore ? { contextBlockStore } : undefined;

      try {
        const mode = resolveDispatchMode(params.document, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const auditTypeText = resolveAuditTypeText(params.auditType);
          const promptTemplate = buildAuditPrompt(auditTypeText, undefined, undefined, hasContextBlocks);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config, { ...runOptions, runtime });
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        // Single-task mode
        const auditTypeText = resolveAuditTypeText(params.auditType);
        const prompt = buildAuditPrompt(auditTypeText, params.document, params.filePaths, hasContextBlocks);
        const results = await runTasks([{ ...baseTaskSpec, prompt } as TaskSpec], config, { ...runOptions, runtime });
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
