import type { LifecycleState } from '../stage-plan-types.js';
import { currentWork } from '../stage-io.js';

/**
 * Deterministic commit-message composition per spec Fix A.
 *
 * Derives a conventional-commit message from:
 * - Subject: execute-plan heading or delegate/retry prompt first line
 * - Type: inferred from leading verb (feat/fix/chore)
 * - Scope: most-common first-segment-after-src/ from filesChanged, omitted if tied or zero
 * - (Task N) trailer: execute-plan only, when present in heading
 * - Body: worker summary, only when summaryTrustworthy === true
 * - Plan footer: execute-plan only
 * - Rework annotation: preserved when review.verdict === 'changes_required' and unaddressedFindingIds non-empty
 */
export function composeCommitMessage(
  state: LifecycleState,
  filesChanged: string[],
  cwd: string,
): string {
  const work = state.gates ? currentWork(state as { gates: Record<string, any> }) : null;
  const route = state.route as string | undefined;
  const isExecutePlan = route === 'execute-plan';
  const task = state.task as { taskDescriptor?: string; planBasename?: string; prompt?: string } | undefined;

  // ─── Step 1: Extract source text (heading or prompt) ───────────────────

  let sourceText = '';
  let taskNumber: string | null = null;

  if (isExecutePlan && task?.taskDescriptor) {
    sourceText = task.taskDescriptor;
    // Extract Task N if present
    const taskMatch = sourceText.match(/Task\s+(\d+)/i);
    if (taskMatch) {
      taskNumber = taskMatch[1];
    }
  } else if (task?.prompt) {
    sourceText = task.prompt;
  }

  // ─── Step 2: Resolve to first usable line ────────────────────────────

  const subjectLine = resolveSubjectLine(sourceText);
  const isUsingFallback = subjectLine === 'feat: update requested files';

  // ─── Early return if using fallback (no scope/trailer recomposition) ──

  if (isUsingFallback) {
    // Body and annotation are not included in fallback case
    return subjectLine;
  }

  // ─── Step 3: Clean and normalize subject ─────────────────────────────

  let cleanSubject = cleanSubjectText(subjectLine);

  // ─── Step 4: Infer type from leading verb ────────────────────────────

  const type = inferType(cleanSubject);

  // ─── Step 5: Derive scope from filesChanged ──────────────────────────

  const scope = deriveScope(filesChanged, cwd);

  // ─── Step 6: Build subject line (type, scope, subject) ──────────────

  let subjectLine_ = scope ? `${type}(${scope}): ${cleanSubject}` : `${type}: ${cleanSubject}`;

  // Add (Task N) trailer if execute-plan and present in heading
  if (isExecutePlan && taskNumber) {
    subjectLine_ += ` (Task ${taskNumber})`;
  }

  // Trim to 72 chars
  if (subjectLine_.length > 72) {
    subjectLine_ = subjectLine_.slice(0, 72);
  }

  // ─── Step 7: Build body (summary only when trustworthy) ──────────────

  let body = '';
  if (work && work.summary && work.summaryTrustworthy === true) {
    body = work.summary;
  }

  // ─── Step 8: Build footer (Plan: basename for execute-plan only) ────

  let footer = '';
  if (isExecutePlan && task?.planBasename) {
    footer = `Plan: ${task.planBasename}`;
  }

  // ─── Step 9: Rework annotation (preserve when applicable) ────────────

  let annotation = '';
  const reviewGate = state.gates?.['review'] as { payload?: { verdict?: string } } | undefined;
  const reviewVerdict = reviewGate?.payload?.verdict;
  const unaddressed = (work as any)?.unaddressedFindingIds ?? [];

  if (reviewVerdict === 'changes_required' && unaddressed.length > 0) {
    annotation = `Rework left ${unaddressed.length} findings unaddressed: ${unaddressed.join(', ')}.`;
  }

  // ─── Step 10: Assemble message ──────────────────────────────────────

  let message = subjectLine_;

  if (body) {
    message += `\n\n${body}`;
  }

  if (annotation) {
    message += `\n\n${annotation}`;
  }

  if (footer) {
    message += `\n\n${footer}`;
  }

  return message;
}

/**
 * Resolve to first usable line.
 * Usable = after stripping Task N: / # / ## / >, contains [A-Za-z].
 * Falls through: source → first usable after skipping empty/quote → "feat: update requested files".
 */
function resolveSubjectLine(sourceText: string): string {
  if (!sourceText) {
    return 'feat: update requested files';
  }

  const lines = sourceText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty
    if (!line) continue;

    // Check if this line is usable
    const usable = isUsable(line);
    if (usable) {
      return line;
    }
  }

  // No usable line found
  return 'feat: update requested files';
}

/**
 * A line is usable if, after stripping Task N: / # / ## / >, it contains [A-Za-z].
 */
function isUsable(line: string): boolean {
  let cleaned = line;

  // Strip leading markdown/task markers
  cleaned = cleaned.replace(/^#+\s*/, ''); // Strip # and ##
  cleaned = cleaned.replace(/^>\s*/, ''); // Strip >
  cleaned = cleaned.replace(/^Task\s+\d+:\s*/i, ''); // Strip Task N:
  cleaned = cleaned.trim();

  // Check for at least one letter
  return /[A-Za-z]/.test(cleaned);
}

/**
 * Clean subject text:
 * - Strip Task N: / # / ## / > markers
 * - Lowercase first letter
 * - Return trimmed result
 */
function cleanSubjectText(line: string): string {
  let cleaned = line;

  // Strip leading markers
  cleaned = cleaned.replace(/^#+\s*/, '');
  cleaned = cleaned.replace(/^>\s*/, '');
  cleaned = cleaned.replace(/^Task\s+\d+:\s*/i, '');
  cleaned = cleaned.trim();

  // Lowercase first letter
  if (cleaned.length > 0) {
    cleaned = cleaned[0].toLowerCase() + cleaned.slice(1);
  }

  return cleaned;
}

/**
 * Infer type from leading verb.
 * - add/implement/create → feat
 * - fix/correct/repair → fix
 * - remove/delete/drop → chore
 * - else → feat
 */
function inferType(subject: string): string {
  const firstWord = subject.split(/\s+/)[0].toLowerCase();

  if (/^(add|implement|create)/.test(firstWord)) {
    return 'feat';
  }
  if (/^(fix|correct|repair)/.test(firstWord)) {
    return 'fix';
  }
  if (/^(remove|delete|drop)/.test(firstWord)) {
    return 'chore';
  }

  return 'feat';
}

/**
 * Derive scope from filesChanged.
 * - Consider only paths that contain a "src/" directory segment
 * - For each match, take first segment after src/ (e.g., packages/core/src/lifecycle/… → lifecycle)
 * - Pick most common segment
 * - Omit scope if zero matches, or if top scopes are tied
 * - Return scope string or empty string
 */
function deriveScope(filesChanged: string[], cwd: string): string {
  // Find all segments (first after src/)
  const segments: string[] = [];

  for (const file of filesChanged) {
    // Resolve to relative path if absolute
    const rel = file.startsWith('/') ? file : `${cwd}/${file}`;

    // Check if path matches */src/*
    if (!rel.includes('/src/')) {
      continue;
    }

    // Extract segment: text after /src/ and before next /
    const srcIdx = rel.indexOf('/src/');
    const afterSrc = rel.slice(srcIdx + 5); // +5 to skip '/src/'
    const segment = afterSrc.split('/')[0];

    if (segment) {
      segments.push(segment);
    }
  }

  // No matching paths
  if (segments.length === 0) {
    return '';
  }

  // Count occurrences
  const counts = new Map<string, number>();
  for (const seg of segments) {
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }

  // Find max count
  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) {
      maxCount = count;
    }
  }

  // Count how many have max count (check for tie)
  let tiedCount = 0;
  let topSegment = '';
  for (const [seg, count] of counts.entries()) {
    if (count === maxCount) {
      tiedCount++;
      topSegment = seg;
    }
  }

  // Omit scope if tied
  if (tiedCount > 1) {
    return '';
  }

  return topSegment;
}
