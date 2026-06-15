// cwd-confinement for the claude worker — the SDK equivalent of codex's
// `-s workspace-write` sandbox (read anywhere, write only inside the workspace).
//
// `permissionMode: 'bypassPermissions'` gives "never prompt" but applies NO
// filesystem boundary. PreToolUse hooks run independently of the permission mode
// (even under bypass), so we add one that DENIES writes whose target path escapes
// the session cwd. Reads/Glob/Grep stay unrestricted — matching codex, where only
// writes are confined. Wired only for `sandboxPolicy: 'cwd-only'` tasks.

import { resolve, relative, isAbsolute, sep } from 'node:path';

/** The claude SDK tools that mutate a file at a caller-supplied path. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Bash tokens that mutate a path argument (vs. merely reading it). */
const BASH_WRITE_CMD_RE =
  /\b(rm|rmdir|mv|cp|tee|dd|install|truncate|chmod|chown|mkdir|touch|ln|rsync)\b|>>?|sed\s+-i|perl\s+-i|git\s+-C\b/;

/** True when `p` (resolved against `cwd`) lands outside the `cwd` subtree. */
export function pathEscapesCwd(p: string, cwd: string): boolean {
  if (!p) return false;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Scan a Bash command for a WRITE that targets an absolute path outside `cwd`.
 * Conservative: only fires when a mutating token co-occurs with an out-of-cwd
 * absolute path, so reads (`cat /etc/...`, `ls /other`) and system-tool use
 * (`/usr/bin/...`, in-cwd writes) are unaffected.
 */
export function bashWritesOutsideCwd(command: string, cwd: string): string | null {
  if (!BASH_WRITE_CMD_RE.test(command)) return null;
  const absPaths = command.match(/(?<![\w=])\/[^\s'";:|&)>]+/g) ?? [];
  for (const p of absPaths) {
    // System roots are never the user's workspace — allow (codex sandbox allows
    // reads/tmp too); only flag absolute paths that escape cwd into user space.
    if (/^\/(usr|bin|sbin|opt|System|Library|private\/var\/folders|tmp|var\/folders|dev|etc|proc)\b/.test(p)) continue;
    if (pathEscapesCwd(p, cwd)) return p;
  }
  return null;
}

type HookResult = {
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
 * Decide a single PreToolUse call. Exported for direct unit testing without the
 * SDK. Returns a deny result, or `{}` to allow.
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
 * Build the `hooks.PreToolUse` entry that confines writes to `cwd`. Shape matches
 * the claude-agent-sdk `HookCallbackMatcher[]` registration.
 */
export function buildCwdConfinementHook(cwd: string): {
  PreToolUse: { hooks: ((input: { tool_name: string; tool_input: unknown }) => Promise<HookResult>)[] }[];
} {
  return {
    PreToolUse: [
      {
        hooks: [async (input) => evaluateConfinement(input.tool_name, input.tool_input, cwd)],
      },
    ],
  };
}
