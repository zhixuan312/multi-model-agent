import { describe, it, expect } from 'vitest';
import type { RunResult } from '../../packages/core/src/types.js';

describe('Executor surfaces structured runner_crash code', () => {
  it('accepts runner_crash as a valid structuredError code at the type level', () => {
    const r: RunResult = {
      output: '',
      status: 'error',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 0,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      structuredError: {
        code: 'runner_crash',
        message: 'test error',
        where: 'executor:test',
      },
    };
    expect(r.structuredError?.code).toBe('runner_crash');
    expect(r.structuredError?.where).toBe('executor:test');
  });
});
