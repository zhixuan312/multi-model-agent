import { describe, it, expect } from 'vitest';
import { classifyDraft } from '../../packages/core/src/intake/classify.js';
import type { DraftTask, DelegateSource } from '../../packages/core/src/intake/types.js';

function makeDraft(overrides: Partial<DraftTask> = {}): DraftTask {
  return {
    draftId: 'test:0:root',
    source: { route: 'delegate_tasks', originalInput: {} } as DelegateSource,
    prompt: 'reply with hello',
    ...overrides,
  } as DraftTask;
}

describe('classify', () => {
  it('returns ready for clear task with done condition', () => {
    const result = classifyDraft(makeDraft({ done: 'greeting returned' }));
    expect(result.classification).toBe('ready');
  });

  it('returns needs_confirmation for vague delegate prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: 'fix it', done: undefined }));
    expect(result.classification).toBe('needs_confirmation');
  });

  it('returns unrecoverable for empty prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: '' }));
    expect(result.classification).toBe('unrecoverable');
  });

  it('returns unrecoverable for single-word prompt', () => {
    const result = classifyDraft(makeDraft({ prompt: 'fix' }));
    expect(result.classification).toBe('unrecoverable');
  });

  it('returns needs_confirmation when draft has open questions', () => {
    const result = classifyDraft(makeDraft({ questions: ['which file?'] }));
    expect(result.classification).toBe('needs_confirmation');
  });

  it('returns ready for confirmed draft', () => {
    const result = classifyDraft(makeDraft({ confirmed: true, prompt: 'fix it' }));
    expect(result.classification).toBe('ready');
  });

  it('returns ready for 2-word prompt that passes vague pattern check', () => {
    const result = classifyDraft(makeDraft({ prompt: 'please help', done: undefined }));
    expect(result.classification).toBe('ready');
  });

  // ── Heuristic false-positive guards ─────────────────────────────────────
  // These prompts used to wedge into needs_confirmation because the prior
  // classifier matched ordinary technical English ("system", "component",
  // "send", "push", "publish") with no scope check on the verb's object.
  // Real destructive ops still flag (see below).
  describe('does NOT flag ordinary technical English without filePaths', () => {
    const cases: Array<[string, string]> = [
      ['analyze the performance of the telemetry system', 'singular system word'],
      ['research industry components and document findings', 'plural components word'],
      ['describe the ingestion layer and its responsibilities', 'singular layer word'],
      ['explain how the billing and reporting modules talk to each other', 'plural modules with "and"'],
      ['send a request to the health endpoint and report the status', 'send a request (non-destructive)'],
      ['publish the docs to the website and verify they render', 'publish docs (non-destructive)'],
      ['push the latest version of the changelog to npm via the standard release script', 'push (general use)'],
      ['summarize the migration history of the schema', 'migrate as noun-context'],
      ['remove the trailing whitespace from the README intro', 'remove a trivial edit'],
    ];
    for (const [prompt, label] of cases) {
      it(label, () => {
        const result = classifyDraft(makeDraft({ prompt, done: undefined }));
        expect(result.classification, `prompt: "${prompt}"`).toBe('ready');
      });
    }
  });

  describe('still flags genuinely destructive prompts without filePaths', () => {
    const cases: Array<[string, string]> = [
      ['drop the users table', 'drop table'],
      ['drop database production', 'drop database'],
      ['delete all files in the temp directory', 'delete all files'],
      ['rm -rf the build output', 'rm -rf'],
      ['force push to main', 'force push to main'],
      ['push --force to origin/master', 'push --force'],
      ['deploy to production right now', 'deploy to production'],
      ['publish the release to prod', 'publish to prod'],
      ['migrate the production database to the new schema', 'migrate production database'],
    ];
    for (const [prompt, label] of cases) {
      it(label, () => {
        const result = classifyDraft(makeDraft({ prompt, done: undefined }));
        expect(result.classification, `prompt: "${prompt}"`).toBe('needs_confirmation');
        expect(result.reasons.some(r => r.includes('behavior-changing'))).toBe(true);
      });
    }
  });

  it('destructive prompt WITH filePaths is ready (explicit scope)', () => {
    const result = classifyDraft(makeDraft({
      prompt: 'drop the users table',
      filePaths: ['/project/db/migrations/001_drop_users.sql'],
      done: undefined,
    }));
    expect(result.classification).toBe('ready');
  });

  it('security-sensitive prompt without done still flags', () => {
    const result = classifyDraft(makeDraft({
      prompt: 'rotate the auth token for the admin user',
      done: undefined,
    }));
    expect(result.classification).toBe('needs_confirmation');
    expect(result.reasons.some(r => r.includes('security-sensitive'))).toBe(true);
  });
});