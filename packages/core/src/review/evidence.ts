import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Commit } from '../runners/base/result-builders.js';
import type { VerifyStageResult } from '../run-tasks/verify-stage.js';

const exec = promisify(execFile);

export interface EvidenceInput {
  cwd: string;
  baselineHead: string;
  commits: Commit[];
  verification: VerifyStageResult;
  reviewPolicy: 'full' | 'spec_only' | 'diff_only' | 'off';
}

export async function buildEvidence(i: EvidenceInput): Promise<{ block: string; diffTruncated: boolean; fullDiff: string }> {
  const { stdout: stat } = await exec('git', ['diff', `${i.baselineHead}..HEAD`, '--stat'], { cwd: i.cwd });
  const { stdout: full } = await exec('git', ['diff', `${i.baselineHead}..HEAD`], { cwd: i.cwd });
  const cap = 64 * 1024;
  // Cap by UTF-8 bytes, not JS-string length, so non-ASCII diffs hit the actual byte cap.
  const fullBytes = Buffer.byteLength(full, 'utf8');
  const diffTruncated = fullBytes > cap;
  const truncFull = diffTruncated
    ? Buffer.from(full, 'utf8').subarray(0, cap).toString('utf8') + '\n[diff truncated]'
    : full;

  let block = '## Implementation evidence\n';
  block += '- Commits:\n';
  for (const c of i.commits) block += `  - ${c.sha.slice(0, 12)} "${c.subject}" (filesChanged: ${c.filesChanged.length})\n`;
  block += `- Verification: ${i.verification.status}\n`;
  for (const s of i.verification.steps) block += `  - \`${s.command}\` → ${s.status}${s.exitCode !== null ? ` (exit=${s.exitCode})` : ''} (${s.durationMs}ms)\n`;
  block += `- Diff stat:\n\n\`\`\`\n${stat}\`\`\`\n\n`;
  block += `- Full diff:\n\n\`\`\`diff\n${truncFull}\n\`\`\`\n`;
  block += `- diffTruncated: ${diffTruncated}\n`;
  return { block, diffTruncated, fullDiff: truncFull };
}
