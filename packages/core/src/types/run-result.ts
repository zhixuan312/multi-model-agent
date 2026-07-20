// Run-result types.
//
// The internal provider-runner contract (SDK ↔ mma): TokenUsage, TurnResult,
// Session, Provider, and the option shapes the two-phase pipeline passes in.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedNonReadTokens: number;
}

export interface TurnResult {
  output: string;
  usage: TokenUsage;
  costUSD: number;
  turns: number;
  durationMs: number;
  terminationReason: 'ok' | 'error' | 'time_exceeded' | 'cap_exhausted' | 'stalled' | 'aborted';
  errorCode?: string;
  filesWritten: string[];
  usedShell: boolean;
}

/** Resolved + staged skills for a worker session. `stagedRoot` contains a
 *  `skills/<name>/` subtree per requested skill (the same layout Codex reads
 *  at `$CODEX_HOME/skills` and the Claude plugin references as `./skills/<name>`). */
export interface ResolvedSkillBundle {
  stagedRoot: string;
  names: string[];
}

export interface SessionOpts {
  cwd?: string;
  wallClockDeadline: number;
  idleStallTimeoutMs?: number;
  abortSignal: AbortSignal;
  bus?: object;
  /** Task identity — required for per-task event tagging so the stall watchdog
   *  can filter the shared bus. Optional only because some unit tests construct
   *  sessions directly without a task context. */
  taskId?: string;
  /** Index within task. */
  taskIndex?: number;
  /** Present only when the task requested skills and resolution succeeded. */
  skills?: ResolvedSkillBundle;
  /** Session ID from a prior task — seeds the provider session so the first
   *  send() resumes the prior conversation instead of starting fresh. */
  resume?: string;
  /** Tools the worker is NOT allowed to use (sandbox enforcement). */
  disallowedTools?: string[];
  /** Filesystem policy for the session. `cwd-only` adds a PreToolUse confinement
   *  hook (claude) that denies writes escaping the cwd — the SDK analog of codex
   *  `-s workspace-write`. Typed inline to avoid importing from `unified/`. */
  sandboxPolicy?: 'cwd-only' | 'read-only';
}

export interface TurnOpts {
  stageLabel?: string;
  /** Cooperative cancellation — pass the per-task stall abort signal so
   *  send() can be unwound by the stuck-detection watchdog. */
  signal?: AbortSignal;
  /** Goal condition — when set, a Stop hook evaluates this condition after
   *  each turn. If not met, the agent continues working. Claude SDK only
   *  (Codex exec does not support programmatic goal evaluation). */
  goalCondition?: string;
}

/** Interface implemented by ClaudeSession and CodexCliSession. */
export interface Session {
  send(instruction: string, opts?: TurnOpts): Promise<TurnResult>;
  close(): Promise<void>;
  /** Returns the OS pid of the active CLI subprocess if one exists. Undefined
   *  between turns or for providers that do not spawn a child (e.g. in-process
   *  SDK clients). Used by shutdown drain to SIGKILL stragglers. */
  getPid?(): number | undefined;
  /** Returns the provider-assigned session/thread ID if one has been captured
   *  (i.e. after the first successful send()). Null before any send or if the
   *  provider never assigns an ID. Used by the unified task API to expose
   *  session identity on the wire. */
  getSessionId(): string | null;
}

// Provider — factory-created handle that openSession returns

export interface Provider {
  name: string;
  /** Provider config — shape varies by runtime (ClaudeProviderConfig | CodexProviderConfig).
   *  Consumers access .type and .model via unsafe downcasts; the full type lives
   *  in types/config.ts to avoid circular deps. */
  config: any;     // v5: ClaudeProviderConfig | CodexProviderConfig (lives in types/config.ts; broadened to avoid circular dep)
  openSession(opts: SessionOpts): Session;
}


