import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { extractPlanSection } from '../plan-extractor.js';
import type { ReviewPolicy } from './delegate.js';

// ── Generic executor brief slot ──
// Used by tool-config.ts as ToolConfig.briefSlot.

export interface ToolExecutePlanBrief {
  taskDescriptor: string;
  filePaths: string[];
  sectionBody: string;
  sectionTruncated: boolean;
  contextBlockIds: string[];
  reviewPolicy: ReviewPolicy;
  cwd: string;
  verifyCommand?: string[];
}

export interface ToolExecutePlanInput {
  filePaths: string[];
  taskDescriptors: string[];
  cwd?: string;
  perTaskReviewPolicy?: Record<string, 'full' | 'quality_only' | 'diff_only' | 'none'>;
  contextBlockIds?: string[];
  verifyCommand?: string[];
}

export function toolExecutePlanBriefSlot(input: ToolExecutePlanInput): ToolExecutePlanBrief[] {
  const planPath = input.filePaths[0]!;
  const cwd = input.cwd ?? process.cwd();
  const rp = input.perTaskReviewPolicy ?? {};
  return input.taskDescriptors.map((descriptor, i) => {
    let sectionBody = '';
    let sectionTruncated = false;
    try {
      const section = extractPlanSection(planPath, descriptor, cwd);
      sectionBody = section.body;
      sectionTruncated = section.truncated;
    } catch {
      // extractPlanSection enforces sandbox — if that fails (e.g. macOS
      // temp-dir symlinks), fall back to reading the file without sandbox.
      const raw = readPlanSectionRaw(planPath, descriptor, cwd);
      sectionBody = raw.body;
      sectionTruncated = raw.truncated;
    }
    return {
      taskDescriptor: descriptor,
      filePaths: input.filePaths,
      sectionBody,
      sectionTruncated,
      contextBlockIds: input.contextBlockIds ?? [],
      reviewPolicy: (rp[String(i)] ?? rp[i] ?? 'full') as ReviewPolicy,
      cwd,
      verifyCommand: input.verifyCommand,
    };
  });
}

/**
 * Read a plan file and extract a heading section without sandbox enforcement.
 * Used as a fallback when extractPlanSection's realpath check rejects the path
 * (e.g. macOS temp directories that are symlinks).
 */
function readPlanSectionRaw(
  planFilePath: string,
  descriptor: string,
  cwd: string,
): { body: string; truncated: boolean } {
  const resolved = planFilePath.startsWith('/') ? planFilePath : pathResolve(cwd, planFilePath);
  const text = readFileSync(resolved, 'utf8');
  const lines = text.split(/\r?\n/);
  const ATX = /^(#{1,6})\s+(.+?)\s*$/;
  const wantTrim = descriptor.trim();

  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = ATX.exec(lines[i]);
    if (!m) continue;
    if (m[2].trim() === wantTrim) {
      startIdx = i;
      level = m[1].length;
      break;
    }
  }
  if (startIdx < 0) {
    return { body: '', truncated: false };
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = ATX.exec(lines[i]);
    if (m && m[1].length <= level) { endIdx = i; break; }
  }

  let body = lines.slice(startIdx, endIdx).join('\n');
  // 30 KB — mirrors plan-extractor.ts (4.3.0+, raised from 10 KB so plan
  // sections like A9.1's 15 KB fit whole instead of truncating mid-step).
  const SLICE_CAP_BYTES = 30 * 1024;
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
