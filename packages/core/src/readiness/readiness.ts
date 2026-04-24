import type { TaskSpec } from '../types.js';
import type { BriefQualityWarning, ReadinessResult, BriefQualityPolicy } from '../intake/types.js';

export function hasScopePillar(prompt: string): boolean {
  if (!prompt.trim()) return false;
  // File path with extension
  if (/\/[\w.-]+\.\w+/.test(prompt)) return true;
  // Directory path (packages/, src/, etc.)
  if (/\b(packages|src|tests|docs|scripts|layout)\/[\w/.-]/.test(prompt)) return true;
  // Glob pattern
  if (/\*\*\/\*\.?\w+/.test(prompt)) return true;
  // Backtick-wrapped module/identifier
  if (/`[\w-]+`/.test(prompt)) return true;
  // Out-of-bounds clause
  if (/do not modify|don't modify|no changes? to|exclude|except/.test(prompt)) return true;
  // Bare topic noun (too vague)
  if (/^(fix|update|change|refactor|improve|add|remove)\s+\w+\s+(stuff|things?|items?|files?|code|logic)\.?$/i.test(prompt)) return false;
  if (/^(fix|update|change)\s+\w+\.?$/.test(prompt)) return false;
  return prompt.length > 20 && /[.\s]/.test(prompt);
}

export function hasInputsPillar(prompt: string): boolean {
  // File reference
  if (/\b[\w-]+\.(ts|js|tsx|jsx|json|md|yml|yaml|toml|ini|cfg|conf)\b/.test(prompt)) return true;
  // Fenced code block
  if (/```[\s\S]*?```/.test(prompt)) return true;
  // "follow/match/based on X" pattern
  if (/follow (the )?pattern (in|from|of)|match (the )?pattern|based on [\w.-]+/.test(prompt)) return true;
  // Backtick identifier
  if (/`[\w/.-]+`/.test(prompt)) return true;
  return false;
}

export function hasDoneConditionPillar(prompt: string): boolean {
  const lc = prompt.toLowerCase();
  // Explicit done-when phrases
  if (/done when|success criteria:|complete when|finished when/.test(lc)) return true;
  // Test pass phrase
  if (/tsc passes?|tests? (all )?pass|eslint|fmt|lint|build(ing)? (succeeds?|passes?)/.test(lc)) return true;
  // Test file reference
  if (/tests?\/[\w/.-]+\.test\.(ts|js)/.test(prompt)) return true;
  // expectedCoverage reference
  if (/expectedcoverage|requiredmarkers/.test(lc)) return true;
  // HTTP status codes as done condition
  if (/status code (200|201|204|4\d{2}|5\d{2})/.test(prompt)) return true;
  // Behavior checklist
  if (/should (be|have|do)|verify |confirm |check(ing)? /.test(lc)) return true;
  return false;
}

function hasTaskInputsPillar(task: Pick<TaskSpec, 'prompt' | 'filePaths'>): boolean {
  if (hasInputsPillar(task.prompt)) return true;
  return Array.isArray(task.filePaths) && task.filePaths.some((p) => p.trim().length > 0);
}

function hasTaskDoneConditionPillar(task: Pick<TaskSpec, 'prompt' | 'done'>): boolean {
  if (hasDoneConditionPillar(task.prompt)) return true;
  return typeof task.done === 'string' && task.done.trim().length > 0;
}

export function hasOutputContractPillar(prompt: string, disableStructuredReport?: boolean): boolean {
  if (!disableStructuredReport) return true;
  // Has explicit format instructions
  if (/return (json|yaml|xml|csv|object|array)|output (should be|as|format)|format( ted)? (as|with)/i.test(prompt)) return true;
  if (/expectedcoverage|requiredmarkers/.test(prompt.toLowerCase())) return true;
  return false;
}

export function detectOutsourcedDiscovery(prompt: string): boolean {
  const lc = prompt.toLowerCase();
  return /find (out |the )?(right|correct)|figure out|verify the exact|determine (the |which )|look up|check (the )?(right|correct) (file|import|path|function)|follow the same (pattern|logic)|based on the same/.test(lc);
}

export function detectBrittleLineAnchors(prompt: string): boolean {
  // Has "lines X-Y" or "lines X–Y" without a semantic anchor nearby
  if (!/lines?\s+\d+[\s–-]+\d+/i.test(prompt)) return false;
  // Check if there's a backtick identifier near the line range (semantic anchor)
  if (/\`[\w`]+\`\s*\(?\s*lines?\s*\d+/i.test(prompt)) return false;
  return true;
}

export function detectMixedEnvironmentActions(prompt: string): boolean {
  const lc = prompt.toLowerCase();
  return /&&?\s*(git\s+(commit|push|pull|merge|rebase)|npm\s+(publish|version)|docker\s+(build|run|push)|deploy|release)/.test(lc) ||
    /(commit|push|pull|merge)\s+(and|&|then)\s+(commit|push|build)/.test(lc);
}

export function detectConcretePath(prompt: string): boolean {
  return /\/[\w.-]+\.\w+/.test(prompt);
}

export function detectNamedCodeArtifact(prompt: string): boolean {
  return /`[\w`]+\`/.test(prompt);
}

export function detectReasonableLength(prompt: string): boolean {
  return prompt.length >= 50 && prompt.length <= 500;
}

export function evaluateReadiness(task: TaskSpec, mode?: BriefQualityPolicy): ReadinessResult {
  const policy = mode ?? task.briefQualityPolicy ?? 'warn';
  
  if (policy === 'off') {
    return { action: 'ignored', missingPillars: [], layer2Warnings: [], layer3Hints: [], briefQualityWarnings: [] };
  }

  const missingPillars: ('scope' | 'inputs' | 'done_condition' | 'output_contract')[] = [];
  if (!hasScopePillar(task.prompt)) missingPillars.push('scope');
  if (!hasTaskInputsPillar(task)) missingPillars.push('inputs');
  if (!hasTaskDoneConditionPillar(task)) missingPillars.push('done_condition');
  if (!hasOutputContractPillar(task.prompt, false)) missingPillars.push('output_contract');

  const layer2Warnings: BriefQualityWarning[] = [];
  if (detectOutsourcedDiscovery(task.prompt)) layer2Warnings.push('outsourced_discovery');
  if (detectBrittleLineAnchors(task.prompt)) layer2Warnings.push('brittle_line_anchors');
  if (detectMixedEnvironmentActions(task.prompt)) layer2Warnings.push('mixed_environment_actions');

  const layer3Hints: ('concrete_path' | 'named_code_artifact' | 'reasonable_length')[] = [];
  if (detectConcretePath(task.prompt)) layer3Hints.push('concrete_path');
  if (detectNamedCodeArtifact(task.prompt)) layer3Hints.push('named_code_artifact');
  const reasonableLength = detectReasonableLength(task.prompt);
  if (!reasonableLength) layer3Hints.push('reasonable_length');

  const briefQualityWarnings: BriefQualityWarning[] = [...layer2Warnings];
  if (missingPillars.includes('scope')) briefQualityWarnings.push('bare_topic_noun');
  if (missingPillars.includes('done_condition')) briefQualityWarnings.push('no_done_condition');
  if (missingPillars.includes('output_contract')) briefQualityWarnings.push('no_output_contract');
  if (task.prompt.length < 50) briefQualityWarnings.push('tiny_brief');
  if (task.prompt.length > 500) briefQualityWarnings.push('huge_brief');

  let action: ReadinessResult['action'] = 'warn';

  if (policy === 'strict') {
    if (missingPillars.length > 0) action = 'refuse';
    else action = 'warn';
  } else if (policy === 'warn') {
    action = 'warn';
  }

  return { action, missingPillars, layer2Warnings, layer3Hints, briefQualityWarnings };
}
