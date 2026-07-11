import { describe, expect, it } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function dispatch(h: { baseUrl: string; token: string }, body: object) {
  return fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
    method: 'POST',
    headers: HEADERS(h.token),
    body: JSON.stringify(body),
  });
}

async function pollToTerminal(h: { baseUrl: string; token: string }, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${h.baseUrl}/task/${taskId}`, { headers: HEADERS(h.token) });
    if (res.status === 200) return (await res.json()) as Record<string, unknown>;
    if (res.status !== 202) throw new Error(`Unexpected ${res.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timeout');
}

describe('spec route component selection', () => {
  it('rejects unknown component labels with 400 invalid_request before dispatch', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const res = await dispatch(h, {
        type: 'spec',
        prompt: 'subset request',
        target: { inline: '## Context\n\n### Background\ntext' },
        components: ['Context', 'Decision Records'],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request');
    } finally {
      await h.close();
    }
  });

  it('injects the resolved canonical subset into both worker prompts', async () => {
    const prompts: string[] = [];
    const reviewerSummary = {
      specPath: '.mma/specs/subset.md',
      sections: ['Context', 'Problem', 'Technical Design'],
      acceptanceCriteriaCount: 0,
      notes: 'subset ok',
    };
    const h = await boot({
      cwd: process.cwd(),
      provider: mockProvider({
        sequence: [
          {
            output: 'implementer wrote subset scaffold',
            status: 'ok',
            workerStatus: 'done',
          },
          {
            output: `\`\`\`json\n${JSON.stringify(reviewerSummary, null, 2)}\n\`\`\``,
            status: 'ok',
            workerStatus: 'done',
          },
        ],
        onPrompt: (prompt) => prompts.push(prompt),
      }),
    });

    try {
      const res = await dispatch(h, {
        type: 'spec',
        prompt: 'subset request',
        target: { inline: '## Context\n\n### Background\ntext' },
        components: ['Technical Design', 'Context', 'Problem', 'Context'],
      });
      expect(res.status).toBe(202);
      const { taskId } = await res.json();
      const terminal = await pollToTerminal(h, taskId);
      expect((terminal.output as Record<string, unknown>).summary).toEqual(reviewerSummary);
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) {
        expect(prompt).toContain('Emit only these spec components, in canonical order: Context, Problem, Technical Design.');
        expect(prompt).not.toContain('Decision Records');
        expect(prompt).not.toContain('Acceptance Criteria');
      }
    } finally {
      await h.close();
    }
  });

  it('treats omitted and empty components as the full canonical set', async () => {
    for (const components of [undefined, []] as const) {
      const prompts: string[] = [];
      const fullSummary = {
        specPath: '.mma/specs/full.md',
        sections: [
          'Context',
          'Problem',
          'Goals & Requirements',
          'Alternatives',
          'Technical Design',
          'Testing Plan',
          'Risks & Mitigations',
          'User Stories & Tasks',
        ],
        acceptanceCriteriaCount: 12,
        notes: 'full ok',
      };

      const h = await boot({
        cwd: process.cwd(),
        provider: mockProvider({
          sequence: [
            {
              output: 'implementer wrote full spec',
              status: 'ok',
              workerStatus: 'done',
            },
            {
              output: `\`\`\`json\n${JSON.stringify(fullSummary, null, 2)}\n\`\`\``,
              status: 'ok',
              workerStatus: 'done',
            },
          ],
          onPrompt: (prompt) => prompts.push(prompt),
        }),
      });

      try {
        const body: Record<string, unknown> = {
          type: 'spec',
          prompt: 'default request',
          target: { inline: '## Context\n\n### Background\ntext' },
        };
        if (components !== undefined) body.components = components;

        const res = await dispatch(h, body);
        expect(res.status).toBe(202);
        const { taskId } = await res.json();
        const terminal = await pollToTerminal(h, taskId);
        expect((terminal.output as Record<string, unknown>).summary).toEqual(fullSummary);
        for (const prompt of prompts) {
          expect(prompt).toContain(
            'Emit only these spec components, in canonical order: Context, Problem, Goals & Requirements, Alternatives, Technical Design, Testing Plan, Risks & Mitigations, User Stories & Tasks.',
          );
        }
      } finally {
        await h.close();
      }
    }
  });
});
