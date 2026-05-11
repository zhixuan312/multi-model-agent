import * as fs from 'node:fs';

export interface EstimateInputs {
  filePaths: string[]; // absolute paths
  contextBlockLengthsChars: number[]; // lengthChars from each block's meta.json
  baseInstructionsTokens: number;
  reservedCompletionTokens: number;
}

export function estimateContextSize(inputs: EstimateInputs): number {
  let total = inputs.baseInstructionsTokens + inputs.reservedCompletionTokens;
  for (const p of inputs.filePaths) {
    try {
      total += Math.ceil(fs.statSync(p).size / 3.5);
    } catch { /* missing files contribute 0; A4a's middleware should have already 400'd if cwd was bad */ }
  }
  for (const len of inputs.contextBlockLengthsChars) {
    total += Math.ceil(len / 3.5);
  }
  return total;
}

export interface OverflowCheckInputs {
  estimatedTokens: number;
  modelCap: number;
  tier: 'standard' | 'complex';
  model: string;
  contributors: Array<{ kind: 'filePath' | 'contextBlock'; path?: string; id?: string; estimatedTokens: number }>;
}

export interface OverflowEnvelope {
  error: 'context_overflow_predicted';
  message: string;
  details: {
    estimatedTokens: number;
    modelCap: number;
    tier: 'standard' | 'complex';
    model: string;
    biggestContributors: OverflowCheckInputs['contributors'];
    recoveryHints: string[];
  };
}

export function checkOverflow(inputs: OverflowCheckInputs): OverflowEnvelope | null {
  if (inputs.estimatedTokens <= inputs.modelCap) return null;
  const sorted = [...inputs.contributors].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  return {
    error: 'context_overflow_predicted',
    message: `Estimated ${inputs.estimatedTokens.toLocaleString()} tokens for this dispatch; tier='${inputs.tier}' (${inputs.model}) cap is ${inputs.modelCap.toLocaleString()} tokens.`,
    details: {
      estimatedTokens: inputs.estimatedTokens,
      modelCap: inputs.modelCap,
      tier: inputs.tier,
      model: inputs.model,
      biggestContributors: sorted,
      recoveryHints: [
        'Split filePaths into smaller batches (e.g., dispatch separately for the largest file).',
        'Trim the largest file (or the largest context block) — these are the inputs the estimator weighs by raw size. Reducing a single dominant input is usually the cheapest fix.',
        "Retry with tier='complex' (mma-delegate accepts agentType='complex'; specialized routes are tier-locked) which has a higher context cap.",
      ],
    },
  };
}
