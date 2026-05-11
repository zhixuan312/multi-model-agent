import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// 30 KB cap (4.3.0+ pipeline redesign).
//
// Smaller caps forced workers to read the full plan file for any task
// section >10 KB. The plan file is often 150+ KB and pushes the worker
// past the model's context window. 30 KB fits every plan section in the
// 2026-05-10 plan whole, while staying well under any modern model's
// context budget. Observed 2026-05-11: A9.1 section is 15 KB → truncated
// at 10 KB mid-Step-5a → reviewers reported "plan incomplete after Step
// 4" and bailed. With 30 KB cap, the section fits whole.
const SLICE_CAP_BYTES = 30 * 1024;

export class PlanExtractionError extends Error {
  constructor(public descriptor: string, public reason: string) {
    super(`plan extractor: ${reason} (descriptor: ${JSON.stringify(descriptor)})`);
    this.name = 'PlanExtractionError';
  }
}

export interface PlanSection {
  descriptor: string;
  body: string;     // <= 10 KB after truncation
  headingLevel: number;
  truncated: boolean;
}

/**
 * Extract the section of a plan file matching `descriptor` (an ATX heading text).
 *
 * R5 audit F5: sandbox enforcement. The plan file path comes from caller input
 * (`filePaths[0]` in the execute_plan request) and MUST be confined to `cwd` —
 * matching the daemon's universal cwd-only sandbox policy.
 */
export function extractPlanSection(planFilePath: string, descriptor: string, cwd: string): PlanSection {
  // Sandbox: resolve through realpath, then assert containment in cwd.
  const cwdReal = realpathSync(resolve(cwd));
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolve(cwdReal, planFilePath));
  } catch (e: any) {
    throw new PlanExtractionError(descriptor, `cannot resolve plan file '${planFilePath}': ${e.message}`);
  }
  if (resolvedReal !== cwdReal && !resolvedReal.startsWith(cwdReal + sep)) {
    throw new PlanExtractionError(descriptor, `plan file path escapes cwd: ${planFilePath}`);
  }

  let text: string;
  try {
    text = readFileSync(resolvedReal, 'utf8');
  } catch (e: any) {
    throw new PlanExtractionError(descriptor, `cannot read plan file '${planFilePath}': ${e.message}`);
  }

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
    throw new PlanExtractionError(descriptor, `no heading matched (must equal an ATX heading text exactly)`);
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = ATX.exec(lines[i]);
    if (m && m[1].length <= level) { endIdx = i; break; }
  }

  let body = lines.slice(startIdx, endIdx).join('\n');
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > SLICE_CAP_BYTES) {
    const buf = Buffer.from(body, 'utf8');
    let slice = buf.subarray(0, SLICE_CAP_BYTES);
    let validEnd = slice.length;
    for (let i = 0; i < 4 && validEnd > 0; i++) {
      const decoded = slice.subarray(0, validEnd).toString('utf8');
      if (!decoded.endsWith('�')) break;
      validEnd--;
    }
    body = slice.subarray(0, validEnd).toString('utf8');
    const lastNewline = body.lastIndexOf('\n');
    if (lastNewline > 0) body = body.slice(0, lastNewline);
    truncated = true;
  }
  return { descriptor: wantTrim, body, headingLevel: level, truncated };
}
