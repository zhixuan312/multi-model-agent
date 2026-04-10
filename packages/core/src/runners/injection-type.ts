import type { DegenerateKind } from './supervision.js';

/**
 * Map a supervision `validation.kind` to the `injectionType` label used in
 * the `ProgressEvent` emitted when the runner injects a supervision
 * re-prompt.
 *
 * `fragment` and `no_terminator` collapse onto `supervise_fragment` because
 * they share a re-prompt style (we quote the tail back at the model) and
 * belong to the same observer bucket — distinguishing them on the event
 * stream would just leak an implementation detail of `validateCompletion`.
 *
 * Shared by every runner (openai / claude / codex) per the "3+ concrete use
 * cases" rule — inlining it three times was the prior state. The helper is
 * deliberately free of any runner- or SDK-specific knowledge.
 */
export function injectionTypeFor(
  kind: DegenerateKind | undefined,
): 'supervise_empty' | 'supervise_thinking' | 'supervise_fragment' {
  switch (kind) {
    case 'empty':
      return 'supervise_empty';
    case 'thinking_only':
      return 'supervise_thinking';
    case 'fragment':
    case 'no_terminator':
    default:
      return 'supervise_fragment';
  }
}
