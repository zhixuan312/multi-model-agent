import { describe, it, expect } from 'vitest';
import { MockRunner } from './fixtures/mock-runner.js';
import { toolConfig as auditToolConfig } from '../../packages/core/src/tools/audit/tool-config.js';
import type { ExecutionContext } from '../../packages/core/src/lifecycle/lifecycle-context.js';

const ctx = {
  cwd: '/tmp',
  config: { defaults: {} },
  projectContext: undefined,
  mainModel: undefined,
} as unknown as ExecutionContext;

function compileAuditPrompts(input: { document?: string; filePaths?: string[]; auditType: string }) {
  const briefs = auditToolConfig.briefSlot({
    document: input.document,
    auditType: input.auditType,
    filePaths: input.filePaths ?? [],
    contextBlockIds: [],
  } as any);
  return briefs.map(b => auditToolConfig.buildTaskSpec(b, ctx));
}

async function dispatchAuditFixture({ runner }: { runner: MockRunner }) {
  const drafts = compileAuditPrompts({
    document: '# Test Specification\n\nThis is a test document for behavioral scope-contract verification.',
    auditType: 'default',
  });
  const results = await Promise.all(drafts.map((d) => runner.run(d.prompt)));
  return { results, drafts };
}

describe('audit prompt scope contract (§6.1 AC)', () => {
  it('produces no glob(**) tool calls when scope clause is present', async () => {
    const mock = new MockRunner({ policy: 'obey-prompt-scope' });
    await dispatchAuditFixture({ runner: mock });

    const calls = mock.capturedToolCalls;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).not.toMatch(/^glob\(.+\*\*/);
    }
  });

  it('includes the scope contract in the compiled prompt', () => {
    const drafts = compileAuditPrompts({ document: '# Test', auditType: 'default' });
    for (const draft of drafts) {
      expect(draft.prompt).toContain('Do NOT enumerate the repository');
      expect(draft.prompt).toContain('the goal is to evaluate the document, not catalog the codebase');
    }
  });

  it('multicase: each fan-out draft includes the scope contract', () => {
    const drafts = compileAuditPrompts({ filePaths: ['/a/x.ts', '/a/y.ts'], auditType: 'security' });
    expect(drafts.length).toBe(2);
    for (const draft of drafts) {
      expect(draft.prompt).toContain('Do NOT enumerate the repository');
    }
  });
});
