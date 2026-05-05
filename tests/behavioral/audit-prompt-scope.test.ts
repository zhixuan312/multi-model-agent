import { describe, it, expect } from 'vitest';
import { MockRunner } from './fixtures/mock-runner.js';
import { compileAuditDocument } from '../../packages/core/src/intake/brief-compiler-slots/audit.js';

async function dispatchAuditFixture({ runner }: { runner: MockRunner }) {
  const drafts = compileAuditDocument(
    {
      document: '# Test Specification\n\nThis is a test document for behavioral scope-contract verification.',
      auditType: 'correctness',
    },
    'test-g7-request',
  );

  const results = await Promise.all(drafts.map((d) => runner.run(d.prompt)));
  return { results, drafts };
}

describe('audit prompt scope contract (§6.1 AC)', () => {
  it('produces no glob(**) tool calls when scope clause is present', async () => {
    const mock = new MockRunner({ policy: 'obey-prompt-scope' });
    await dispatchAuditFixture({ runner: mock });

    const calls = mock.capturedToolCalls;
    // The mock should produce at least one base tool call (readFile)
    // on any audit fixture — the fixture references an .md file in
    // its document text. If capturedToolCalls is empty, the mock's
    // prompt detection heuristics may need updating.
    expect(calls.length).toBeGreaterThan(0);

    for (const c of calls) {
      expect(c).not.toMatch(/^glob\(.+\*\*/);
    }
  });

  it('includes the scope contract in the compiled prompt', () => {
    const drafts = compileAuditDocument(
      { document: '# Test', auditType: 'correctness' },
      'test-g7-scope',
    );

    for (const draft of drafts) {
      expect(draft.prompt).toContain('Do NOT enumerate the repository');
      expect(draft.prompt).toContain('Stay scoped: the goal is to evaluate the document');
    }
  });

  it('multicase: each fan-out draft includes the scope contract', () => {
    const drafts = compileAuditDocument(
      { filePaths: ['/a/x.ts', '/a/y.ts'], auditType: 'security' },
      'test-g7-multi',
    );

    expect(drafts.length).toBe(2);
    for (const draft of drafts) {
      expect(draft.prompt).toContain('Do NOT enumerate the repository');
    }
  });
});
