import { describe, it, expect, vi } from 'vitest';
import { mockProvider, capExhaustingProvider, clarificationProvider, throwingProvider } from '../contract/fixtures/mock-providers.js';
import type { ExecutionContext } from '../../packages/core/src/executors/types.js';
import type { MultiModelConfig, Provider } from '../../packages/core/src/types.js';

const providerState = vi.hoisted(() => ({ activeProvider: undefined as Provider | undefined }));

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: () => providerState.activeProvider,
}));

import { executeInvestigate, type InvestigateExecutorInput } from '../../packages/core/src/executors/investigate.js';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface MakeCtxOpts {
  workerOutput?: string;
  capExhausted?: 'turn' | 'cost' | 'wall_clock';
  lifecycleClarificationRequested?: boolean;
  workerError?: Error;
  capturePromptIntoCallable?: { lastPrompt?: string };
}

function makeCtx(opts: MakeCtxOpts = {}): { ctx: ExecutionContext; cwd: string; promptCapture: { lastPrompt?: string } } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'inv-rl-')));
  mkdirSync(join(cwd, 'src/auth'), { recursive: true });
  writeFileSync(join(cwd, 'src/auth/refresh.ts'), '');
  const promptCapture: { lastPrompt?: string } = opts.capturePromptIntoCallable ?? {};

  let provider: any;
  if (opts.workerError) {
    provider = throwingProvider(opts.workerError);
  } else if (opts.lifecycleClarificationRequested) {
    provider = clarificationProvider({ proposedInterpretation: 'please clarify' });
  } else if (opts.capExhausted) {
    provider = capExhaustingProvider({ kind: opts.capExhausted, partialOutput: opts.workerOutput ?? '' });
  } else {
    provider = mockProvider({ output: opts.workerOutput ?? '', onPrompt: (prompt: string) => { promptCapture.lastPrompt = prompt; } });
  }

  providerState.activeProvider = provider;
  const config = {
    providers: { default: provider },
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
  } as unknown as MultiModelConfig;

  const ctx: ExecutionContext = {
    projectContext: { cwd, contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any, lastActivityAt: Date.now() } as any,
    config,
    logger: { event: () => {}, child: () => ({ event: () => {} } as any) } as any,
    contextBlockStore: { get: () => undefined, register: () => ({ id: 'x' }) } as any,
    batchId: 'test-batch',
  };
  return { ctx, cwd, promptCapture };
}

function defaultArgs(question = 'q'): InvestigateExecutorInput {
  return { input: { question }, resolvedContextBlocks: [], canonicalizedFilePaths: [], relativeFilePathsForPrompt: [] };
}

describe('executeInvestigate reviewed-execution parser + envelope flow', () => {
  it('16. valid bulleted citations → done', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- src/auth/refresh.ts:45-72 — Refresh handler reads bearer.\n## Confidence\nhigh — verified\n' });
    const out = await executeInvestigate(ctx, defaultArgs('How does refresh work?'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done');
    expect(r.structuredReport.investigation.citations).toEqual([{ file: 'src/auth/refresh.ts', lines: '45-72', claim: 'Refresh handler reads bearer.' }]);
    expect(out.headline).toMatch(/^Investigation: ".*" — 1 citations, confidence high, /);
  });

  it('17. no parseable section headers → blocked, investigation absent', async () => {
    const { ctx } = makeCtx({ workerOutput: 'I refused this request.' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('blocked');
    expect(r.structuredReport?.investigation).toBeUndefined();
  });

  it('18. (none) citations + low confidence → done', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nNo evidence found.\n## Citations\n(none)\n## Confidence\nlow — searched broadly\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done');
    expect(r.structuredReport.investigation.citations).toEqual([]);
    expect(r.structuredReport.investigation.diagnostics.invalidRequiredSections).toEqual([]);
  });

  it('19. turn cap with partial report → done_with_concerns + turn_cap', async () => {
    const { ctx } = makeCtx({
      capExhausted: 'turn',
      workerOutput: '## Summary\npartial\n## Citations\n- a:1 — c\n',
    });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.incompleteReason).toBe('turn_cap');
    expect(out.headline).toContain('done with concerns (turn_cap)');
  });

  it('20. unparseable Confidence → done_with_concerns + missing_sections', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nmaybe?\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.incompleteReason).toBe('missing_sections');
    expect(r.structuredReport.investigation.confidence).toBeNull();
    expect(r.structuredReport.investigation.diagnostics.invalidRequiredSections).toContain('confidence');
    expect(r.structuredReport.investigation.diagnostics.missingRequiredSections).not.toContain('confidence');
  });

  it('21. Confidence section omitted → missing, not invalid', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.incompleteReason).toBe('missing_sections');
    expect(r.structuredReport.investigation.diagnostics.missingRequiredSections).toContain('confidence');
    expect(r.structuredReport.investigation.diagnostics.invalidRequiredSections).not.toContain('confidence');
  });

  it('22. Windows-style citation path parsed correctly', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- C:\\repo\\src\\file.ts:45 — handles refresh\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.investigation.citations[0]).toEqual({ file: 'C:\\repo\\src\\file.ts', lines: '45', claim: 'handles refresh' });
  });

  it('23. reversed range citation → dropped, malformed=1', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- src/a.ts:20-10 — c\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.investigation.diagnostics.malformedCitationLines).toBe(1);
    expect(r.structuredReport.investigation.citations).toEqual([]);
    expect(r.workerStatus).toBe('done_with_concerns');
  });

  it('24. (none) for files-changed and validations-run → empty arrays', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n## Files changed\n(none)\n## Validations run\n(none)\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.filesChanged).toEqual([]);
    expect(r.structuredReport.validationsRun).toEqual([]);
  });

  it('25. summary content survives the no-artifacts wrapper', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nAuthoritative answer.\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.summary).toBe('Authoritative answer.');
  });

  it('26. all-malformed citations → done_with_concerns + missing_sections; invalidRequiredSections has citations', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- src/a.ts:abc — c\n- not-a-citation\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.incompleteReason).toBe('missing_sections');
    expect(r.structuredReport.investigation.diagnostics.malformedCitationLines).toBe(2);
    expect(r.structuredReport.investigation.diagnostics.invalidRequiredSections).toContain('citations');
  });

  it('27. empty Summary → done_with_concerns + missing_sections; invalidRequiredSections has summary', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\n   \n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.structuredReport.investigation.diagnostics.invalidRequiredSections).toContain('summary');
  });

  it('28. numbered-list citation bullets → both parsed', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n1. src/a.ts:12 — a\n2) src/b.ts:13-15 -- b\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.investigation.citations).toHaveLength(2);
  });

  it('29. invalid line tokens (table-driven) → all dropped', async () => {
    const cases = [
      'src/a.ts:001',
      'src/a.ts:0',
      'src/a.ts:0-10',
      'src/a.ts:1-01',
      'src/a.ts:-5',
      'src/a.ts:99999999999999999999',
    ];
    const body = cases.map(c => `- ${c} — claim`).join('\n');
    const { ctx } = makeCtx({ workerOutput: `## Summary\nx\n## Citations\n${body}\n## Confidence\nhigh — x\n` });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.investigation.citations).toEqual([]);
    expect(r.structuredReport.investigation.diagnostics.malformedCitationLines).toBe(cases.length);
  });

  it('30. POSIX path with embedded colon → parsed', async () => {
    const { ctx } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\nsrc/foo:bar/file.ts:45 — c\n## Confidence\nhigh — x\n' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.structuredReport.investigation.citations[0]).toEqual({ file: 'src/foo:bar/file.ts', lines: '45', claim: 'c' });
  });

  it('31. headline question normalization (whitespace + quotes + emoji)', async () => {
    const { ctx: ctxA } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n' });
    const outA = await executeInvestigate(ctxA, defaultArgs('Where is\n  "refresh"\n handled?'));
    expect(outA.headline).toContain('"Where is \\"refresh\\" handled?"');

    const { ctx: ctxB } = makeCtx({ workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n' });
    const outB = await executeInvestigate(ctxB, defaultArgs('\u{1F680}'.repeat(70)));
    expect(outB.headline).toContain('\u{1F680}'.repeat(60) + '…');
  });

  it('32. needsContext + no_structured_report → needs_context (precedence)', async () => {
    const { ctx } = makeCtx({ lifecycleClarificationRequested: true, workerOutput: '' });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('needs_context');
  });

  it('33. wall_clock cap with parseable partial output → done_with_concerns + timeout', async () => {
    const { ctx } = makeCtx({
      capExhausted: 'wall_clock',
      workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n',
    });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('done_with_concerns');
    expect(r.incompleteReason).toBe('timeout');
  });

  it('34. cap with no parseable output AND workerError → blocked (workerError wins per precedence rule 2)', async () => {
    const { ctx } = makeCtx({ workerError: new Error('cap exhausted before any output') });
    const out = await executeInvestigate(ctx, defaultArgs('q'));
    const r = (out.results as any[])[0];
    expect(r.workerStatus).toBe('blocked');
  });

  it('35. anchor path emitted as relative in prompt', async () => {
    const promptCapture: { lastPrompt?: string } = {};
    const { ctx, cwd } = makeCtx({ capturePromptIntoCallable: promptCapture, workerOutput: '## Summary\nx\n## Citations\n- a:1 — c\n## Confidence\nhigh — x\n' });
    await executeInvestigate(ctx, {
      input: { question: 'q' },
      resolvedContextBlocks: [],
      canonicalizedFilePaths: [join(cwd, 'src/auth')],
      relativeFilePathsForPrompt: ['src/auth'],
    });
    expect(promptCapture.lastPrompt).toContain('- src/auth');
    expect(promptCapture.lastPrompt).not.toContain(`- ${cwd}/src/auth`);
  });
});
