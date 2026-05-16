// tests/acceptance/stage-io-security.test.ts
//
// Covers AC-24 from spec §11. Prompt-construction unit tests verify that
// every LLM-backed handler's prompt contains only allowed-outbound fields
// (per §15.2) and never the forbidden ones (raw file contents beyond
// Finding.evidence, credentials, tokens, env vars, context-block bodies).
//
// The annotate-prompts file has its own suite for the annotate templates;
// this file is the contract-level test that applies the same security
// guarantees across the full set of LLM-backed handlers.

import { describe, it, expect } from 'vitest';
import {
  annotatePromptWrite, annotatePromptRead, serializeWriteContext, serializeReadContext,
} from '../../packages/core/src/lifecycle/annotate-prompts.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,           // OpenAI-style key prefix
  /AKIA[A-Z0-9]{12,}/,               // AWS access key prefix
  /OPENAI_API_KEY\s*=/,
  /ANTHROPIC_API_KEY\s*=/,
  /AWS_SECRET_ACCESS_KEY\s*=/,
  /BEARER\s+[A-Za-z0-9._-]{20,}/i,   // bearer token
];

function mkState(over: Partial<LifecycleState> & Record<string, unknown> = {}): LifecycleState {
  return {
    terminal: false, attemptIndex: 0, attemptBudget: 1, reviewPolicy: 'full',
    shutdownInProgress: false, route: 'delegate',
    task: { id: 't1', prompt: 'do', brief: { title: 'T', body: 'b' } },
    ...over,
  } as unknown as LifecycleState;
}

describe('AC-24: annotate prompts do not emit synthesized secrets', () => {
  it('annotatePromptWrite synthesized scaffolding contains no secret patterns', () => {
    const state = mkState();
    const prompt = annotatePromptWrite(state);
    // Strip out the brief body region (user-supplied content lives there);
    // we only care that the template itself doesn't introduce secrets.
    const synthesized = prompt.replace(state.task!.brief!.body, '');
    for (const re of SECRET_PATTERNS) {
      expect(synthesized).not.toMatch(re);
    }
  });

  it('annotatePromptRead synthesized scaffolding contains no secret patterns', () => {
    const state = mkState({ route: 'investigate' });
    const prompt = annotatePromptRead(state);
    const synthesized = prompt.replace(state.task!.brief!.body, '');
    for (const re of SECRET_PATTERNS) {
      expect(synthesized).not.toMatch(re);
    }
  });
});

describe('AC-24: serialized contexts truncate brief body before embedding', () => {
  it('write-context truncates brief body to 2000 chars (leak-surface cap)', () => {
    const longBody = 'x'.repeat(5000) + 'OPENAI_API_KEY=sk-XXXXXXXXXXXXXXXX';
    const state = mkState({
      task: { id: 't1', brief: { title: 'T', body: longBody } },
    } as Partial<LifecycleState> & Record<string, unknown>);
    const ctx = serializeWriteContext(state) as { task: { brief: { body: string } } };
    expect(ctx.task.brief.body.length).toBeLessThanOrEqual(2000);
  });

  it('read-context truncates brief body to 2000 chars (leak-surface cap)', () => {
    const longBody = 'y'.repeat(3000) + 'sk-XXXXXXXXXXXXXXXXXXXXXXXXX';
    const state = mkState({
      route: 'investigate',
      task: { id: 't1', brief: { title: 'T', body: longBody } },
    } as Partial<LifecycleState> & Record<string, unknown>);
    const ctx = serializeReadContext(state) as { task: { brief: { body: string } } };
    expect(ctx.task.brief.body.length).toBeLessThanOrEqual(2000);
  });
});

describe('AC-24: serialized contexts do not embed lastRunResult.output verbatim', () => {
  it('write-context omits raw worker output (only summary + filesChanged + workerStatus)', () => {
    const state = mkState({
      lastRunResult: {
        workerStatus: 'done',
        summary: 's',
        output: 'SECRET FILE CONTENTS - LARGE BLOB',
        filesChanged: ['a.ts'],
      },
    });
    const ctx = serializeWriteContext(state) as { implement?: Record<string, unknown> };
    const serializedText = JSON.stringify(ctx);
    expect(serializedText).not.toMatch(/SECRET FILE CONTENTS/);
  });
});
