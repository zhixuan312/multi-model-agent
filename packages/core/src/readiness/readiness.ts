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

export function hasOutputContractPillar(prompt: string, disableStructuredReport?: boolean): boolean {
  if (!disableStructuredReport) return true;
  // Has explicit format instructions
  if (/return (json|yaml|xml|csv|object|array)|output (should be|as|format)|format( ted)? (as|with)/i.test(prompt)) return true;
  if (/expectedcoverage|requiredmarkers/.test(prompt.toLowerCase())) return true;
  return false;
}
