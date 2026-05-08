import type { RunResult, TaskSpec } from '../types.js';

/**
 * 4.0.3+: signature accepts optional `runResult` and `task` so composers
 * can read fields the structured `report` doesn't carry (e.g.,
 * `annotatedFindings` from runResult, `filePaths` from task).
 * Backwards-compatible at runtime — composers that ignore both keep
 * working.
 */
export interface HeadlineTemplate {
  compose(input: {
    taskBrief: string;
    report: unknown;
    status: string;
    runResult?: RunResult;
    task?: TaskSpec;
  }): string;
}

export class HeadlineComposer {
  constructor(private template: HeadlineTemplate) {}

  compose(input: {
    taskBrief: string;
    report: unknown;
    status: string;
    runResult?: RunResult;
    task?: TaskSpec;
  }): string {
    return this.template.compose(input);
  }
}
