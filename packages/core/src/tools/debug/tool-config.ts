import { ToolSurfaceRegistry } from '../../tool-surface/tool-surface-registry.js';
import { inputSchema } from './schema.js';
import type { Input } from './schema.js';
import { qualityDebugTemplate } from '../../review/reviewer-engine.js';
import type { ToolConfig } from '../../lifecycle/tool-config-types.js';
import type { ExecutionContext } from '../../lifecycle/lifecycle-context.js';
import { debugBriefSlot, type ToolDebugBrief } from '../../intake/brief-compiler-slots/debug.js';
import { debugHeadlineTemplate } from '../../reporting/headline-templates/debug.js';
import { DEFAULT_TASK_TIMEOUT_MS } from '../../config/schema.js';

export function registerDebug(registry: ToolSurfaceRegistry): void {
  registry.register({
    routeName: 'debug',
    httpMethod: 'POST',
    httpPath: '/debug',
    surface: 'tool',
    schema: inputSchema,
    toolCategory: 'read_only',
    agentTypeDefault: 'complex',
    agentTypeOverridable: false,
    responseShapeName: 'BatchResponse',
  });
}

const FINDING_FORMAT_INSTRUCTIONS = [
  'Use hypothesis-driven debugging. Use this EXACT per-finding format so the deterministic extractor can recover findings if the structured reviewer pass fails:',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Hypothesis: the candidate cause',
  '- Evidence: trace, log, or code path with file:line',
  '- Fix: proposed change',
  '',
  '## Finding 2: <one-line title>',
  '- Severity: ...',
  '- ...',
  '',
  'Rules:',
  '- Each finding heading MUST start with "## Finding N: " (h2, "Finding ", number, colon, title) — number sequentially from 1.',
  '- Severity / Hypothesis / Evidence / Fix bullets are on their own lines with the labels exactly as shown.',
  '- Do NOT emit JSON. Both the structured reviewer and the deterministic fallback extract from this same format — the format is the single source of truth.',
].join('\n');

function buildFilePathsPrompt(filePaths?: string[]): string {
  if (!filePaths || filePaths.length === 0) return '';
  return `Read and analyze these files:\n${filePaths.map(p => `- ${p}`).join('\n')}`;
}

export const toolConfig: ToolConfig<Input, ToolDebugBrief, unknown> = {
  name: 'debug',
  category: 'read_only',
  agentType: 'complex',
  briefSlot: debugBriefSlot,
  buildTaskSpec: (brief, ctx) => {
    const parts: string[] = [`Debug this problem:\n\n${brief.problem}`];
    if (brief.context) parts.push(`Context: ${brief.context}`);
    if (brief.hypothesis) parts.push(`Initial hypothesis: ${brief.hypothesis}`);
    const fileSection = buildFilePathsPrompt(brief.filePaths);
    if (fileSection) parts.push(fileSection);
    parts.push(FINDING_FORMAT_INSTRUCTIONS);
    const prompt = parts.join('\n\n');

    return {
      prompt,
      agentType: 'complex',
      reviewPolicy: 'quality_only',
      briefQualityPolicy: 'off',
      done: 'Identify the root cause with evidence (file, line, mechanism). Propose a fix. Verify the fix resolves the problem.',
      tools: ctx.config.defaults?.tools ?? 'full',
      timeoutMs: ctx.config.defaults?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      maxCostUSD: ctx.config.defaults?.maxCostUSD ?? 10,
      sandboxPolicy: ctx.config.defaults?.sandboxPolicy ?? 'cwd-only',
      cwd: ctx.projectContext?.cwd ?? ctx.cwd,
      contextBlockIds: brief.contextBlockIds,
      autoCommit: false,
    };
  },
  reportSchema: { parse: (_text) => { throw new Error('no structured report emitted by this executor'); } },
  headlineTemplate: debugHeadlineTemplate,
  reviewTemplates: {
    qualityAP: qualityDebugTemplate,
  },
};
