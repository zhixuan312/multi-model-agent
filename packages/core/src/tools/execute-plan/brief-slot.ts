import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { extractPlanSection, SLICE_CAP_BYTES } from './plan-extractor.js';
import type { GoalReviewPolicy } from '../../types/goal.js';
import type { TaskInput } from '../../lifecycle/goal-builder.js';

// ── Brief slot for the execute-plan route ──
// One goal-set per call: each task descriptor → one GoalTask whose body is the
// matched plan section. The whole plan runs as a single autonomous implement
// pass (self-commit per task) then a complex-tier review-fix pass.

export interface ExecutePlanBrief {
  tasks: TaskInput[];
  reviewPolicy: GoalReviewPolicy;
  filePaths: string[];
  contextBlockIds: string[];
  cwd: string;
}

export interface ExecutePlanInput {
  filePaths: string[];
  taskDescriptors: string[];
  cwd?: string;
  perTaskReviewPolicy?: Record<string, 'full' | 'quality_only' | 'diff_only' | 'none'>;
  contextBlockIds?: string[];
}

const ATX = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Derive a 1-based plan-phase per descriptor from the plan's heading structure.
 * Tasks (the descriptors) live at some heading level L; their parent sections
 * (level L-1) are the plan-phase boundaries. A new phase starts at each
 * level-(L-1) heading. Plans with no grouping above the tasks → all phase 1.
 */
export function derivePhases(planText: string, descriptors: string[]): number[] {
  const want = new Set(descriptors.map((d) => d.trim()));
  const headings: Array<{ level: number; text: string }> = [];
  for (const line of planText.split(/\r?\n/)) {
    const m = ATX.exec(line);
    if (m) headings.push({ level: m[1]!.length, text: m[2]!.trim() });
  }
  const descLevels = headings.filter((h) => want.has(h.text)).map((h) => h.level);
  if (descLevels.length === 0) return descriptors.map(() => 1);
  const taskLevel = Math.min(...descLevels);
  const phaseLevel = taskLevel - 1;
  const phaseOf = new Map<string, number>();
  let phase = 0;
  for (const h of headings) {
    if (h.level === phaseLevel) phase += 1;
    if (want.has(h.text) && !phaseOf.has(h.text)) phaseOf.set(h.text, Math.max(phase, 1));
  }
  return descriptors.map((d) => phaseOf.get(d.trim()) ?? 1);
}

function readPlanText(planPath: string, cwd: string): string {
  try {
    const resolved = planPath.startsWith('/') ? planPath : pathResolve(cwd, planPath);
    return readFileSync(resolved, 'utf8');
  } catch { return ''; }
}

export function executePlanBriefSlot(input: ExecutePlanInput): ExecutePlanBrief[] {
  const planPath = input.filePaths[0]!;
  const cwd = input.cwd ?? process.cwd();
  const rp = input.perTaskReviewPolicy ?? {};
  const phases = derivePhases(readPlanText(planPath, cwd), input.taskDescriptors);

  const tasks: TaskInput[] = input.taskDescriptors.map((descriptor, i) => {
    let sectionBody = '';
    let sectionTruncated = false;
    try {
      const section = extractPlanSection(planPath, descriptor, cwd);
      sectionBody = section.body;
      sectionTruncated = section.truncated;
    } catch {
      const raw = readPlanSectionRaw(planPath, descriptor, cwd);
      sectionBody = raw.body;
      sectionTruncated = raw.truncated;
    }
    const body = sectionBody.trim().length > 0
      ? (sectionTruncated
          ? `${sectionBody}\n\n⚠ Section truncated at the size cap — read the full plan file (${planPath}) for the tail if needed.`
          : sectionBody)
      : `No unique plan section matched "${descriptor}". Read the plan file ${planPath}, find this task, and implement it. If still no unique match, report and skip this task.`;
    return { heading: descriptor, body, phase: phases[i] ?? 1 };
  });

  // Collapse per-task review policy to the goal axis: review unless every task opted out.
  const allNone = input.taskDescriptors.every((_, i) => (rp[String(i)] ?? rp[i] ?? 'full') === 'none');
  const reviewPolicy: GoalReviewPolicy = allNone ? 'none' : 'review-fix';

  return [{
    tasks,
    reviewPolicy,
    filePaths: input.filePaths,
    contextBlockIds: input.contextBlockIds ?? [],
    cwd,
  }];
}

/**
 * Read a plan file and extract a heading section without sandbox enforcement.
 * Fallback when extractPlanSection's realpath check rejects the path (e.g.
 * macOS temp directories that are symlinks).
 */
function readPlanSectionRaw(
  planFilePath: string,
  descriptor: string,
  cwd: string,
): { body: string; truncated: boolean } {
  const resolved = planFilePath.startsWith('/') ? planFilePath : pathResolve(cwd, planFilePath);
  const text = readFileSync(resolved, 'utf8');
  const lines = text.split(/\r?\n/);
  const wantTrim = descriptor.trim();

  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = ATX.exec(lines[i]!);
    if (!m) continue;
    if (m[2]!.trim() === wantTrim) {
      startIdx = i;
      level = m[1]!.length;
      break;
    }
  }
  if (startIdx < 0) {
    return { body: '', truncated: false };
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = ATX.exec(lines[i]!);
    if (m && m[1]!.length <= level) { endIdx = i; break; }
  }

  let body = lines.slice(startIdx, endIdx).join('\n');
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > SLICE_CAP_BYTES) {
    const buf = Buffer.from(body, 'utf8');
    body = buf.subarray(0, SLICE_CAP_BYTES).toString('utf8');
    const lastNewline = body.lastIndexOf('\n');
    if (lastNewline > 0) body = body.slice(0, lastNewline);
    truncated = true;
  }
  return { body, truncated };
}
