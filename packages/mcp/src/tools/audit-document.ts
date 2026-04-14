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
  applyCommonFields,
} from './shared.js';
import { buildFanOutResponse } from './batch-response.js';

export const auditDocumentSchema = z.object({
  document: z.string().optional().describe('Inline document content to audit'),
  auditType: z.union([
    z.enum(['security', 'performance', 'correctness', 'style', 'general']),
    z.array(z.enum(['security', 'performance', 'correctness', 'style'])).min(1),
  ]).describe('Audit focus. Single string or array of types. "general" = all four categories.'),
  outputFormat: z.enum(['json', 'markdown']).optional()
    .describe('Output format. json returns structured findings array.'),
  agentType: z.enum(['standard', 'complex']).optional(),
  ...commonToolFields,
});

export type AuditDocumentParams = z.infer<typeof auditDocumentSchema>;

function resolveAuditTypeText(auditType: AuditDocumentParams['auditType']): string {
  if (auditType === 'general') return 'security, performance, correctness, and style';
  if (Array.isArray(auditType)) return auditType.join(', ');
  return auditType;
}

function buildAuditPrompt(
  auditTypeText: string,
  document: string | undefined,
  filePaths: string[] | undefined,
  outputFormat: string | undefined,
): string {
  const parts: string[] = [`Audit for ${auditTypeText} issues.`];
  if (outputFormat === 'json') {
    parts.push('Return findings as a JSON array of objects with keys: severity, category, finding, recommendation.');
  }
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

      const agentType = params.agentType ?? 'complex';
      const auditTypeText = resolveAuditTypeText(params.auditType);
      const baseTaskSpec: Partial<TaskSpec> = applyCommonFields(
        {
          agentType,
          reviewPolicy: 'off' as const,
          ...(params.outputFormat && { formatConstraints: { outputFormat: params.outputFormat } }),
        },
        params,
      );

      try {
        const mode = resolveDispatchMode(params.document, params.filePaths);

        if (mode === 'fan_out') {
          const validPaths = params.filePaths!.filter(p => p.trim().length > 0);
          const promptTemplate = buildAuditPrompt(auditTypeText, undefined, undefined, params.outputFormat);
          const tasks: TaskSpec[] = validPaths.map(fp => ({
            ...baseTaskSpec,
            prompt: buildPerFilePrompt(fp, promptTemplate),
          } as TaskSpec));

          const startMs = Date.now();
          const results = await runTasks(tasks, config);
          return { content: [buildFanOutResponse(results, tasks, Date.now() - startMs)] };
        }

        // Single-task mode
        const prompt = buildAuditPrompt(auditTypeText, params.document, params.filePaths, params.outputFormat);
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
