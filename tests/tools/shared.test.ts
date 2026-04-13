import { describe, it, expect } from 'vitest';
import {
  resolveDispatchMode,
  buildMetadataBlock,
  buildFilePathsPrompt,
  buildPerFilePrompt,
  applyCommonFields,
  validateInput,
} from '../../packages/mcp/src/tools/shared.js';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

describe('resolveDispatchMode', () => {
  it('returns single when inline content is provided', () => {
    expect(resolveDispatchMode('content', ['a.ts', 'b.ts'])).toBe('single');
  });
  it('returns single when only 1 filePath and no content', () => {
    expect(resolveDispatchMode(undefined, ['a.ts'])).toBe('single');
  });
  it('returns fan_out when 2+ filePaths and no content', () => {
    expect(resolveDispatchMode(undefined, ['a.ts', 'b.ts'])).toBe('fan_out');
  });
  it('returns single when no content and empty filePaths', () => {
    expect(resolveDispatchMode(undefined, [])).toBe('single');
  });
  it('treats whitespace-only content as absent', () => {
    expect(resolveDispatchMode('   ', ['a.ts', 'b.ts'])).toBe('fan_out');
  });
  it('returns single when no filePaths at all', () => {
    expect(resolveDispatchMode(undefined, undefined)).toBe('single');
  });
});

describe('validateInput', () => {
  it('returns valid for non-empty trimmed content', () => {
    expect(validateInput('content', undefined)).toEqual({ valid: true });
  });
  it('returns valid for non-empty filePaths', () => {
    expect(validateInput(undefined, ['a.ts'])).toEqual({ valid: true });
  });
  it('returns invalid for neither content nor filePaths', () => {
    expect(validateInput(undefined, undefined).valid).toBe(false);
  });
  it('returns invalid for whitespace-only content and empty filePaths', () => {
    expect(validateInput('   ', []).valid).toBe(false);
  });
  it('returns invalid for empty strings in filePaths', () => {
    expect(validateInput('', ['  ', '']).valid).toBe(false);
  });
});

describe('buildFilePathsPrompt', () => {
  it('returns empty string for undefined', () => {
    expect(buildFilePathsPrompt(undefined)).toBe('');
  });
  it('returns empty string for empty array', () => {
    expect(buildFilePathsPrompt([])).toBe('');
  });
  it('returns formatted list', () => {
    const result = buildFilePathsPrompt(['src/a.ts', 'src/b.ts']);
    expect(result).toContain('Read and analyze these files:');
    expect(result).toContain('- src/a.ts');
    expect(result).toContain('- src/b.ts');
  });
});

describe('buildPerFilePrompt', () => {
  it('appends file path to template', () => {
    const result = buildPerFilePrompt('src/a.ts', 'Audit for correctness issues.');
    expect(result).toContain('Audit for correctness issues.');
    expect(result).toContain('Read and analyze this file:');
    expect(result).toContain('- src/a.ts');
  });
});

describe('buildMetadataBlock', () => {
  it('returns JSON content block with expected fields', () => {
    const r = {
      output: 'test', status: 'ok' as const,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
      turns: 3, durationMs: 5000,
      filesRead: ['a.ts'], filesWritten: [], directoriesListed: ['.'],
      toolCalls: ['readFile(a.ts)'],
      outputIsDiagnostic: false, escalationLog: [],
      workerStatus: 'done' as const,
      specReviewStatus: 'not_run' as const,
      qualityReviewStatus: 'not_run' as const,
    } satisfies RunResult;
    const block = buildMetadataBlock(r);
    expect(block.type).toBe('text');
    const parsed = JSON.parse(block.text);
    expect(parsed.status).toBe('ok');
    expect(parsed.usage.costUSD).toBe(0.01);
    expect(parsed.filesRead).toEqual(['a.ts']);
    expect(parsed.directoriesListed).toEqual(['.']);
  });
});

describe('applyCommonFields', () => {
  it('merges cwd, contextBlockIds, tools into taskSpec', () => {
    const result = applyCommonFields({}, { cwd: '/tmp', contextBlockIds: ['abc'], tools: 'readonly' });
    expect(result.cwd).toBe('/tmp');
    expect(result.contextBlockIds).toEqual(['abc']);
    expect(result.tools).toBe('readonly');
  });
  it('omits undefined fields', () => {
    const result = applyCommonFields({ prompt: 'test' }, {});
    expect(result).toEqual({ prompt: 'test' });
    expect('cwd' in result).toBe(false);
  });
});