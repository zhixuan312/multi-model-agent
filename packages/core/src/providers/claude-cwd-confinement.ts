// cwd-confinement for the claude worker — the SDK equivalent of codex's
// `-s workspace-write` sandbox (read anywhere, write only inside the workspace).
//
// `permissionMode: 'bypassPermissions'` gives "never prompt" but applies NO
// filesystem boundary. PreToolUse hooks run independently of the permission mode
// (even under bypass), so we add one that DENIES writes whose target path escapes
// the session cwd. Reads/Glob/Grep stay unrestricted — matching codex, where only
// writes are confined. Wired only for `sandboxPolicy: 'cwd-only'` tasks.
//
// read-only mode: a stricter variant that blocks ALL write tools regardless of
// path. Used for audit/investigate/review/research tasks that should never mutate
// the workspace.

import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { SandboxPolicy } from '../unified/type-registry.js';

/** The claude SDK tools that mutate a file at a caller-supplied path. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Bash tokens that mutate a path argument (vs. merely reading it). */
const BASH_WRITE_CMD_RE =
  /\b(rm|rmdir|mv|cp|tee|dd|install|truncate|chmod|chown|mkdir|touch|ln|rsync)\b|>>?|sed\s+-i|perl\s+-i|git\s+-C\b/;

/** Interpreter invocations with inline code that can write to arbitrary paths. */
const INTERPRETER_WRITE_RE =
  /\b(python3?|node|ruby|perl)\s+(-[ce]\b|--eval\b)/;

/** Network tools that write downloaded content to a file path. */
const DOWNLOAD_WRITE_RE =
  /\b(curl\s+.*-[oO]\b|wget\s+.*-[OP]\b)/;

/** `cd <path>` at the start of a command or after a chain operator. */
const CD_SEGMENT_RE = /(?:^|&&|;|\|\|)\s*cd\s+([^\s;|&]+)/g;

/** True when `p` (resolved against `cwd`) lands outside the `cwd` subtree. */
export function pathEscapesCwd(p: string, cwd: string): boolean {
  if (!p) return false;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Track `cd` segments in a chained command and return the effective cwd after
 * all `cd` invocations. Returns the original cwd when no `cd` is found.
 */
export function resolveEffectiveCwd(command: string, cwd: string): string {
  let effective = cwd;
  let m: RegExpExecArray | null;
  CD_SEGMENT_RE.lastIndex = 0;
  while ((m = CD_SEGMENT_RE.exec(command)) !== null) {
    const target = m[1]!.replace(/^['"]|['"]$/g, '');
    effective = isAbsolute(target) ? target : resolve(effective, target);
  }
  return effective;
}

/**
 * Scan a Bash command for a WRITE that targets a path outside `cwd`.
 * Catches:
 *   1. Classic mutating commands (rm, mv, cp, …) with absolute out-of-cwd paths
 *   2. `cd /outside && <write>` chains where the effective cwd shifts
 *   3. Interpreter subshells (`python -c`, `node -e`) with out-of-cwd absolute paths
 *   4. Download tools (`curl -o`, `wget -O`) targeting out-of-cwd paths
 */
export function bashWritesOutsideCwd(command: string, cwd: string): string | null {
  // Phase 1: detect `cd` chains that shift the effective cwd outside the workspace.
  // When the effective cwd escapes AND a mutating token follows, deny.
  const effectiveCwd = resolveEffectiveCwd(command, cwd);
  if (pathEscapesCwd(effectiveCwd, cwd) && BASH_WRITE_CMD_RE.test(command)) {
    return effectiveCwd;
  }

  // Phase 2: interpreter subshells with absolute out-of-cwd paths.
  if (INTERPRETER_WRITE_RE.test(command)) {
    const absPaths = command.match(/(?<![\w=])\/[^\s'";:|&)>]+/g) ?? [];
    for (const p of absPaths) {
      if (isSystemRoot(p) || isUrlFragment(p)) continue;
      if (pathEscapesCwd(p, cwd)) return p;
    }
  }

  // Phase 3: download tools writing to out-of-cwd paths.
  if (DOWNLOAD_WRITE_RE.test(command)) {
    const absPaths = command.match(/(?<![\w=])\/[^\s'";:|&)>]+/g) ?? [];
    for (const p of absPaths) {
      if (isSystemRoot(p) || isUrlFragment(p)) continue;
      if (pathEscapesCwd(p, cwd)) return p;
    }
  }

  // Phase 4: original check — classic mutating commands with absolute escape paths.
  if (!BASH_WRITE_CMD_RE.test(command)) return null;
  const absPaths = command.match(/(?<![\w=])\/[^\s'";:|&)>]+/g) ?? [];
  for (const p of absPaths) {
    if (isSystemRoot(p) || isUrlFragment(p)) continue;
    if (pathEscapesCwd(p, cwd)) return p;
  }
  return null;
}

function isSystemRoot(p: string): boolean {
  return /^\/(usr|bin|sbin|opt|System|Library|private\/var\/folders|tmp|var\/folders|dev|etc|proc)\b/.test(p);
}

/** True when a path-like string is actually a URL fragment (e.g. `//example.com/f`
 *  extracted from `https://example.com/f` by the absolute-path regex). */
function isUrlFragment(p: string): boolean {
  return p.startsWith('//') || /^\/[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}\//.test(p);
}

export type HookResult = {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
};

function deny(reason: string): HookResult {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

/**
 * Evaluate confinement for `cwd-only` policy: writes inside cwd are allowed,
 * writes outside cwd are denied, reads are unrestricted.
 */
export function evaluateConfinement(toolName: string, toolInput: unknown, cwd: string): HookResult {
  const ti = (toolInput ?? {}) as { file_path?: unknown; notebook_path?: unknown; path?: unknown; command?: unknown };

  if (WRITE_TOOLS.has(toolName)) {
    const target = [ti.file_path, ti.notebook_path, ti.path].find((v) => typeof v === 'string') as string | undefined;
    if (target && pathEscapesCwd(target, cwd)) {
      return deny(
        `Write blocked: "${target}" is outside the task workspace (${cwd}). ` +
          `This task may only modify files inside its worktree — make your change there.`,
      );
    }
  }

  if (toolName === 'Bash' && typeof ti.command === 'string') {
    const escape = bashWritesOutsideCwd(ti.command, cwd);
    if (escape) {
      return deny(
        `Bash write blocked: the command writes to "${escape}", outside the task workspace (${cwd}). ` +
          `Reads are fine, but only write inside your worktree.`,
      );
    }
  }

  return {};
}

/**
 * Evaluate confinement for `read-only` policy: ALL write tools are denied
 * regardless of path. Reads are unrestricted.
 */
export function evaluateReadOnly(toolName: string, toolInput: unknown): HookResult {
  if (WRITE_TOOLS.has(toolName)) {
    return deny(
      `Write blocked: this is a read-only task. Write/Edit/MultiEdit/NotebookEdit are not permitted.`,
    );
  }

  if (toolName === 'Bash' && typeof (toolInput as { command?: unknown })?.command === 'string') {
    const command = (toolInput as { command: string }).command;
    if (BASH_WRITE_CMD_RE.test(command) || INTERPRETER_WRITE_RE.test(command) || DOWNLOAD_WRITE_RE.test(command)) {
      return deny(
        `Bash write blocked: this is a read-only task. Mutating shell commands are not permitted. ` +
          `Use read-only commands (cat, grep, find, ls, git log, etc.) instead.`,
      );
    }
  }

  return {};
}

/**
 * Build the `hooks.PreToolUse` entry for the given sandbox policy. Shape matches
 * the claude-agent-sdk `HookCallbackMatcher[]` registration.
 *
 * - `cwd-only`: confines writes to `cwd`, reads unrestricted.
 * - `read-only`: blocks all write tools regardless of path.
 */
export function buildConfinementHook(policy: SandboxPolicy, cwd: string): {
  PreToolUse: { hooks: ((input: { tool_name: string; tool_input: unknown }) => Promise<HookResult>)[] }[];
} {
  const evaluator = policy === 'read-only'
    ? (input: { tool_name: string; tool_input: unknown }) => evaluateReadOnly(input.tool_name, input.tool_input)
    : (input: { tool_name: string; tool_input: unknown }) => evaluateConfinement(input.tool_name, input.tool_input, cwd);

  return {
    PreToolUse: [
      {
        hooks: [async (input) => evaluator(input)],
      },
    ],
  };
}

