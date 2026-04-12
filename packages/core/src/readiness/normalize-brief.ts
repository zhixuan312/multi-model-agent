import type { TaskSpec, MultiModelConfig } from '../types.js';
import { createProvider } from '../provider.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { computeNormalizationBudget } from './normalization-budget.js';

export interface NormalizationDecision {
  original: string;
  resolved: string;
  reason: string;
}

export interface NormalizationResult {
  normalizedPrompt: string;
  decisions: NormalizationDecision[];
  writeSet: string[];
  verificationPlan: string[];
  unresolved: string[];
  spentCostUSD: number;
  skipped: boolean;
}

const NORMALIZER_PROMPT = `You are a brief normalizer. Given a task brief, analyze it for vagueness and provide concrete normalization.

Brief to normalize:
{prompt}

Respond with a structured normalization using these sections:

## Summary
One sentence summary of what needs to be done.

## Normalization decisions
- "original phrase" → "concrete interpretation"
List each vague element and its concrete resolution.

## Files to change
List the specific files that need modification.

## Verification plan
How to verify the task is done correctly.

## Unresolved
Any elements that still need clarification.

## Done condition
The specific criterion for marking this task complete.`;

export async function normalizeBrief(
  task: TaskSpec,
  config: MultiModelConfig,
): Promise<NormalizationResult> {
  const budget = computeNormalizationBudget(task.maxCostUSD);
  
  const normalizerTask: TaskSpec = {
    prompt: NORMALIZER_PROMPT.replace('{prompt}', task.prompt),
    agentType: 'standard',
    briefQualityPolicy: 'off',
    maxCostUSD: budget,
    tools: 'none',
  };

  try {
    const provider = createProvider('standard', config);
    const result = await delegateWithEscalation(
      normalizerTask,
      [provider],
      { explicitlyPinned: true },
    );

    if (result.status !== 'ok') {
      return {
        normalizedPrompt: task.prompt,
        decisions: [],
        writeSet: [],
        verificationPlan: [],
        unresolved: ['Normalization failed: ' + (result.error || result.status)],
        spentCostUSD: result.usage.costUSD ?? 0,
        skipped: true,
      };
    }

    return parseNormalizationReport(result.output, task.prompt, result.usage.costUSD ?? 0);
  } catch (err) {
    return {
      normalizedPrompt: task.prompt,
      decisions: [],
      writeSet: [],
      verificationPlan: [],
      unresolved: [err instanceof Error ? err.message : String(err)],
      spentCostUSD: 0,
      skipped: true,
    };
  }
}

function parseNormalizationReport(
  output: string,
  originalPrompt: string,
  costUSD: number,
): NormalizationResult {
  const decisions: NormalizationDecision[] = [];
  const writeSet: string[] = [];
  const verificationPlan: string[] = [];
  const unresolved: string[] = [];

  const decisionMatch = output.match(/## Normalization decisions\n([\s\S]*?)(?=\n##|\n##|$)/i);
  if (decisionMatch) {
    const lines = decisionMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      const match = line.match(/- "([^"]+)" → "?([^"\n]+)"?/);
      if (match) {
        decisions.push({ original: match[1], resolved: match[2], reason: 'normalized' });
      }
    }
  }

  const filesMatch = output.match(/## Files to change\n([\s\S]*?)(?=\n##|\n##|$)/i);
  if (filesMatch) {
    const lines = filesMatch[1].split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    for (const line of lines) {
      const file = line.replace(/^[-*]\s*/, '').trim();
      if (file && !file.startsWith('#')) {
        writeSet.push(file);
      }
    }
  }

  const verifyMatch = output.match(/## Verification plan\n([\s\S]*?)(?=\n##|\n##|$)/i);
  if (verifyMatch) {
    const lines = verifyMatch[1].split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    for (const line of lines) {
      const item = line.replace(/^[-*]\s*/, '').trim();
      if (item && !item.startsWith('#')) {
        verificationPlan.push(item);
      }
    }
  }

  const unresolvedMatch = output.match(/## Unresolved\n([\s\S]*?)(?=\n##|\n##|$)/i);
  if (unresolvedMatch) {
    const lines = unresolvedMatch[1].split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    for (const line of lines) {
      const item = line.replace(/^[-*]\s*/, '').trim();
      if (item && !item.startsWith('#')) {
        unresolved.push(item);
      }
    }
  }

  const normalizedPrompt = decisions.length > 0
    ? decisions.reduce((prompt, d) => prompt.replace(d.original, d.resolved), originalPrompt)
    : originalPrompt;

  return {
    normalizedPrompt,
    decisions,
    writeSet,
    verificationPlan,
    unresolved,
    spentCostUSD: costUSD,
    skipped: false,
  };
}
