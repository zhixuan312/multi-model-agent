import type { RunnerShell } from '../runner-shell/shell.js';

export interface ReviewTemplate {
  systemPrompt: string;
  buildUserPrompt(ctx: { workerOutput: string; brief: string; filesChanged?: string[] }): string;
}

export const specTemplate: ReviewTemplate = {
  systemPrompt: `You are a spec compliance reviewer. Check whether the implementer satisfied the task exactly.
Return a JSON block with: {"verdict":"approved"|"changes_required","concerns":["concern1",...]}`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};

export const qualityAPTemplate: ReviewTemplate = {
  systemPrompt: `You are a code quality reviewer. Check whether the implementation is sound, safe, and maintainable.
Return a JSON block with: {"verdict":"approved"|"concerns","concerns":["concern1",...]}`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};

export const diffTemplate: ReviewTemplate = {
  systemPrompt: `You are reviewing a diff. Reply with EXACTLY one of: APPROVE, CONCERNS: <reasons>, or REJECT: <reason>`,
  buildUserPrompt(ctx) {
    return `Task: ${ctx.brief}\n\nWorker output:\n${ctx.workerOutput}`;
  },
};

export class ReviewerPromptBuilder {
  constructor(
    private templates: {
      spec: ReviewTemplate;
      qualityForAP: ReviewTemplate;
      diff: ReviewTemplate;
    },
  ) {}

  buildSpec(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.spec.systemPrompt,
      userPrompt: this.templates.spec.buildUserPrompt(ctx),
    };
  }

  buildQualityAP(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.qualityForAP.systemPrompt,
      userPrompt: this.templates.qualityForAP.buildUserPrompt(ctx),
    };
  }

  buildDiff(ctx: { workerOutput: string; brief: string }): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: this.templates.diff.systemPrompt,
      userPrompt: this.templates.diff.buildUserPrompt(ctx),
    };
  }
}

export class ReviewerEngine {
  constructor(
    private shell: RunnerShell,
    private builder: ReviewerPromptBuilder,
  ) {}

  async runSpec(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<{ verdict: string; concerns: string[] }> {
    const { systemPrompt, userPrompt } = this.builder.buildSpec({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    const text = result.finalAssistantText ?? '';
    return this.parseVerdict(text);
  }

  async runQualityAP(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<{ verdict: string; concerns: string[] }> {
    const { systemPrompt, userPrompt } = this.builder.buildQualityAP({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    const text = result.finalAssistantText ?? '';
    return this.parseVerdict(text);
  }

  async runDiff(state: {
    workerOutput: string;
    brief: string;
    cwd: string;
  }): Promise<{ verdict: string }> {
    const { systemPrompt, userPrompt } = this.builder.buildDiff({
      workerOutput: state.workerOutput,
      brief: state.brief,
    });
    const result = await this.shell.run({
      systemPrompt,
      userMessage: userPrompt,
      toolDefinitions: [],
      maxTurns: 5,
      cwd: state.cwd,
    });
    const text = (result.finalAssistantText ?? '').trim();
    if (text === 'APPROVE') return { verdict: 'approved' };
    if (text.startsWith('CONCERNS:')) return { verdict: 'concerns' };
    if (text.startsWith('REJECT:')) return { verdict: 'changes_required' };
    // Unrecognized output (truncated, malformed, or error response) defaults to 'concerns'
    // so it requires human review rather than silently passing.
    return { verdict: 'concerns' };
  }

  private parseVerdict(text: string): { verdict: string; concerns: string[] } {
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (m) {
      try {
        const p = JSON.parse(m[1]);
        return { verdict: p.verdict ?? 'approved', concerns: p.concerns ?? [] };
      } catch { /* fall through to structured fallback */ }
    }
    const lower = text.toLowerCase();
    // Match on word boundaries to avoid substring false positives
    // (e.g. "no concerns" or "addresses all concerns" must not trigger 'concerns')
    if (/\bchanges_required\b/.test(lower)) return { verdict: 'changes_required', concerns: [] };
    if (/\bconcerns\b/.test(lower)) return { verdict: 'concerns', concerns: [] };
    return { verdict: 'approved', concerns: [] };
  }
}
