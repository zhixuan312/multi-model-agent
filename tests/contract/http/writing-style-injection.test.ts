import { describe, expect, it } from 'vitest';
import { TASK_TYPES, TYPE_REGISTRY, type TaskType } from '../../../packages/core/src/unified/type-registry.js';
import { WRITING_STYLE_BLOCK } from '../../../packages/core/src/unified/writing-style-block.js';
import { runTwoPhasePipeline } from '../../../packages/core/src/unified/two-phase-pipeline.js';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

async function promptsFor(type: TaskType): Promise<string[]> {
  const prompts: string[] = [];
  const provider = mockProvider({
    sequence: [{ output: 'implementer output' }, { output: '{}' }],
    onPrompt: (prompt) => prompts.push(prompt),
  });
  await runTwoPhasePipeline({
    type,
    readerFacing: TYPE_REGISTRY[type].readerFacing,
    implementerSkill: `implementer skill for ${type}`,
    reviewerSkill: `reviewer skill for ${type}`,
    taskPayload: '{"prompt":"contract test"}',
    implementerProvider: provider,
    reviewerProvider: provider,
    implementerTier: 'complex',
    reviewerTier: 'standard',
    reviewPolicy: type === 'orchestrate' ? 'none' : 'reviewed',
    cwd: process.cwd(),
    sandboxPolicy: TYPE_REGISTRY[type].sandbox,
    writeRoute: false,
  });
  return prompts;
}

describe('reader-facing writing-style injection', () => {
  it('carries the registry flag through the HTTP execution runtime', async () => {
    const prompts: string[] = [];
    const h = await boot({
      cwd: process.cwd(),
      provider: mockProvider({
        sequence: [{ output: '{"criteriaCovered":[],"findings":[]}' }, { output: '{"criteriaCovered":[],"findings":[]}' }],
        onPrompt: (prompt) => prompts.push(prompt),
      }),
    });
    try {
      const response = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Main-Model': 'claude-opus-4-8',
          'X-MMA-Client': 'claude-code',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ type: 'audit', target: { inline: '# Contract target' } }),
      });
      expect(response.status).toBe(202);
      for (let attempt = 0; attempt < 300 && prompts.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(prompts).toHaveLength(2);
      expect(prompts[0].startsWith(`${WRITING_STYLE_BLOCK}\n\n`)).toBe(true);
      expect(prompts[1].startsWith(`${WRITING_STYLE_BLOCK}\n\n`)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('prefixes both phases for all nine reader-facing task types and neither phase for excluded types', async () => {
    const readerFacing = new Set<TaskType>(['audit', 'investigate', 'review', 'debug', 'research', 'journal_recall', 'journal_record', 'spec', 'plan']);
    expect(TASK_TYPES).toHaveLength(12);

    for (const type of TASK_TYPES) {
      const prompts = await promptsFor(type);
      expect(TYPE_REGISTRY[type].readerFacing).toBe(readerFacing.has(type));
      expect(prompts).toHaveLength(type === 'orchestrate' ? 1 : 2);
      for (const prompt of prompts) {
        if (readerFacing.has(type)) {
          expect(prompt.startsWith(`${WRITING_STYLE_BLOCK}\n\n`)).toBe(true);
        } else {
          expect(prompt).not.toContain(WRITING_STYLE_BLOCK);
          expect(prompt.startsWith('implementer skill for') || prompt.startsWith('reviewer skill for')).toBe(true);
        }
      }
    }
  });
});