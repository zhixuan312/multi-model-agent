import { describe, it, expect } from 'vitest';
import { resolveDraft } from '../../packages/core/src/intake/resolve.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const CONFIG: MultiModelConfig = {
  agents: { standard: { type: 'openai-compatible', model: 'std', baseUrl: 'http://localhost' }, complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'http://localhost' } },
  defaults: { timeoutMs: 600_000, tools: 'full', sandboxPolicy: 'cwd-only' },
};

describe('resolve', () => {
  it('resolves delegate task with defaults', () => {
    const draft: DraftTask = {
      draftId: 'test:0:root',
      source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
      prompt: 'say hello',
      filePaths: ['a.ts'],
    };
    const resolved = resolveDraft(draft, CONFIG);
    expect(resolved.prompt).toBe('say hello');
    expect(resolved.agentType).toBe('standard');
    expect(resolved.tools).toBe('full');
    expect(resolved.timeoutMs).toBe(600_000);
  });

  it('sets complex agentType for review preset', () => {
    const draft: DraftTask = {
      draftId: 'test:0:root',
      source: { route: 'review_code', originalInput: {}, code: 'const x=1;' } as DraftTask['source'],
      prompt: 'review',
    };
    const resolved = resolveDraft(draft, CONFIG);
    expect(resolved.agentType).toBe('complex');
  });

  it('does not append output contract for delegate_tasks', () => {
    const draft: DraftTask = {
      draftId: 'test:0:root',
      source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
      prompt: 'say hello',
    };
    const resolved = resolveDraft(draft, CONFIG);
    expect(resolved.prompt).toBe('say hello');
  });
});