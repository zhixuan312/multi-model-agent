import type { Provider, ProviderConfig, RunResult } from '@zhixuan92/multi-model-agent-core';

export interface MockRunnerOptions {
  policy: 'obey-prompt-scope';
}

export class MockRunner implements Provider {
  name = 'mock-runner';
  config: ProviderConfig;
  capturedToolCalls: string[] = [];
  capturedPrompts: string[] = [];

  private policy: 'obey-prompt-scope';

  constructor(opts: MockRunnerOptions) {
    this.policy = opts.policy;
    this.config = {
      type: 'codex',
      model: 'mock-model',
      baseUrl: 'http://mock.local',
      apiKey: 'mock',
    } as ProviderConfig;
  }

  async run(prompt: string): Promise<RunResult> {
    this.capturedPrompts.push(prompt);

    const hasScopeClause =
      prompt.includes('Do NOT enumerate the repository') ||
      prompt.includes('Stay within the requested files');
    const toolCalls: string[] = [];

    // Deterministic base: always emit at least one scoped readFile to
    // model baseline tool use. The scope clause tells the agent to
    // "read the exact files referenced" — not glob the repo.
    toolCalls.push('readFile(/project/target.md)');

    // Policy: if the scope clause is present, the "agent" stays scoped and
    // does NOT enumerate the repository. If the clause is absent (regression),
    // the mock emits glob(**) calls — which the test will catch.
    if (!hasScopeClause) {
      toolCalls.push('glob(**/*.ts)');
      toolCalls.push('glob(**/*.md)');
    }

    this.capturedToolCalls.push(...toolCalls);

    return {
      output: JSON.stringify({
        findings: [
          {
            severity: 'medium',
            file: '/test/fixture.md',
            line: 1,
            claim: 'Mock finding for behavioral test',
            sourceQuote: 'test fixture content',
          },
        ],
      }),
      status: 'ok',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.001 },
      turns: 1,
      filesRead: ['/test/fixture.md'],
      filesWritten: [],
      toolCalls,
      outputIsDiagnostic: false,
      escalationLog: [],
      durationMs: 0,
    } as RunResult;
  }
}
