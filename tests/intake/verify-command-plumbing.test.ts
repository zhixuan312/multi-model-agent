import { describe, it, expect, vi } from 'vitest';
import { compileDelegateTasks } from '@zhixuan92/multi-model-agent-core/intake/brief-compiler-slots/delegate';
import { compileExecutePlan } from '@zhixuan92/multi-model-agent-core/intake/brief-compiler-slots/execute-plan';
import { resolveDraft } from '@zhixuan92/multi-model-agent-core/intake/resolve';

describe('verifyCommand intake plumbing', () => {
  it('delegate compiler threads verifyCommand from DelegateTaskInput → DraftTask → TaskSpec', () => {
    const drafts = compileDelegateTasks([{
      prompt: 'do thing',
      verifyCommand: ['npm', 'test'],
    }], 'test-req-id');
    expect(drafts[0].verifyCommand).toEqual(['npm', 'test']);

    const config = { agents: { standard: { type: 'claude-compatible', model: 'm', apiKey: 'k' } } } as any;
    const spec = resolveDraft(drafts[0], config);
    expect(spec.verifyCommand).toEqual(['npm', 'test']);
  });

  it('execute-plan compiler threads verifyCommand', () => {
    const result = compileExecutePlan({
      verifyCommand: ['npm', 'run', 'lint'],
      tasks: ['### Task 1: do thing'],
      filePaths: [],
      fileContents: '',
    } as any, 'test-req-id');
    expect(result[0]?.verifyCommand).toEqual(['npm', 'run', 'lint']);
  });

  it('resolveDraft preserves verifyCommand in TaskSpec so verify stage receives it', () => {
    const drafts = compileDelegateTasks([{
      prompt: 'run tests',
      verifyCommand: ['echo', 'ok'],
    }], 'req-1');

    const config: any = {
      agents: { standard: { type: 'openai-compatible', model: 'm', baseUrl: 'http://localhost' } },
      defaults: { tools: 'full', timeoutMs: 30000, maxCostUSD: 10, sandboxPolicy: 'cwd-only' },
    };
    const spec = resolveDraft(drafts[0], config);

    // verifyCommand survives the full intake chain (compiler → resolveDraft → TaskSpec).
    // The TaskSpec is then consumed by runTasks → reviewed-lifecycle → verify stage.
    expect(spec.verifyCommand).toEqual(['echo', 'ok']);
  });
});
