// packages/core/src/lifecycle/warm-followup.ts
//
// Every "warm follow-up" message — a message sent into a session that
// already contains the prior conversation for the current task —
// MUST be built via buildWarmFollowupMessage(). The shared preamble
// tells the model not to re-explore context already loaded in the
// thread; that is the entire optimization that makes resumed sessions
// worth using.
//
// Cold-open messages (Implementing turn 1, Spec Review turn 1, Retry,
// fresh task dispatches) are NOT built through this helper.

export const WARM_FOLLOWUP_PREAMBLE = `Context for this task is already loaded in this thread — the brief, prior outputs, file contents you've read, and earlier tool results. Use them directly to answer the new instruction below. Do not re-grep, re-read, or re-discover material already in this conversation. Only fetch a new source if the new instruction names one you haven't yet loaded.`;

export function buildWarmFollowupMessage(instructionBody: string): string {
  return `${WARM_FOLLOWUP_PREAMBLE}\n\n${instructionBody}`;
}
