// cwd-confinement for the claude worker — the SDK equivalent of codex's
// `-s workspace-write` sandbox: read anywhere, write only inside the workspace OR a temp dir.
//
// The temp allowance is part of the policy, not an exception to it: codex's OS sandbox permits it
// and cannot be tightened, so denying it here would make `cwd-only` mean two different things
// depending on which runner picked up the task.
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
import { gitDenialInCommand, pathTouchesGitDir } from './git-policy.js';
import { CLAUDE_WRITE_TOOLS } from './claude-tool-categories.js';

/**
 * The claude SDK tools that mutate a file at a caller-supplied path — the SAME set the
 * reporter classifies writes with.
 *
 * This was a private copy of the four names. `claude-tool-categories.ts` calls itself the
 * single source of truth and names its two consumers so they "CAN'T disagree"; the third
 * consumer, this one, was the security-critical path and the one nothing bound. The drift it
 * allowed runs one way and always unsafe: a write tool added there but not here is REPORTED
 * as a write (and auto-committed) while going entirely unconfined — writing outside the
 * workspace on a `cwd-only` task, and writing at all on a `read-only` one.
 */
const WRITE_TOOLS = CLAUDE_WRITE_TOOLS;

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

  // Phase 2: a command that can write SOMEWHERE — a classic mutating command, an interpreter
  // subshell, or a download tool — scanned for an absolute path that leaves the workspace.
  //
  // The three triggers had a scan loop each, verbatim, extraction regex included. Three copies
  // of one rule, in the file whose job is to have exactly one write boundary: a change to how
  // paths are extracted (quoting, say) had to land in all three, and the copy that was missed
  // would keep its own idea of what counts as a path.
  if (!canWrite(command)) return null;
  return firstPathOutsideCwd(command, cwd);
}

/** True when the command can write at all: a mutating command, an interpreter running inline
 *  code, or a download tool saving to a path. */
function canWrite(command: string): boolean {
  return BASH_WRITE_CMD_RE.test(command)
    || INTERPRETER_WRITE_RE.test(command)
    || DOWNLOAD_WRITE_RE.test(command);
}

/** The first absolute path in the command that leaves `cwd`, or null. Paths that are not write
 *  targets (interpreter binaries, /dev, URL fragments) and temp paths are skipped. */
function firstPathOutsideCwd(command: string, cwd: string): string | null {
  const absPaths = command.match(/(?<![\w=])\/[^\s'";:|&)>]+/g) ?? [];
  for (const p of absPaths) {
    if (isIgnorableScanPath(p)) continue;
    if (pathEscapesCwd(p, cwd)) return p;
  }
  return null;
}

/**
 * A temp directory — WRITABLE under `cwd-only`, by policy.
 *
 * `cwd-only` means "writes confined to the cwd **and the temp dirs**", because that is exactly what
 * codex's `-s workspace-write` OS sandbox permits (see codex-cli-launch.ts). The claude hook is the
 * SDK equivalent of that sandbox, and a boundary that differs by runner is not one boundary.
 *
 * This is deliberately separate from `isNonWriteTargetPath` below. The two used to be one list,
 * which made a policy allowance ("temp is writable") indistinguishable from a parser workaround
 * ("this path is not a write target"). Splitting them is what let the Write tool adopt the temp
 * allowance without also adopting the workaround — the two enforcement paths disagreed about temp
 * for exactly as long as one list served both purposes.
 */
function isTempPath(p: string): boolean {
  return /^\/(?:private\/)?(?:tmp|var\/folders)\b/.test(p);
}

/**
 * A path that appears in a command but is not what the command WRITES: interpreter and binary
 * directories, and the /dev and /proc pseudo-filesystems. Skipped so `python3 /usr/bin/foo …` and
 * `cmd > /dev/null` are not misread as escapes.
 *
 * This is a parser workaround, not a permission. It must never grow to include a directory a
 * worker could plausibly be told to write into — that is what put `/tmp` here.
 *
 * `/etc` is the uncomfortable member. A shell write there is genuinely not flagged, but the scan
 * cannot separate `echo x > /etc/f` from `python -c "...open('/etc/hosts')..."`, and denying the
 * read is a concrete regression against a mostly theoretical write: a worker runs as the invoking
 * user and has no write permission on /etc. The OS is the boundary there, not this hook. Pinned by
 * a test so the gap stays a decision.
 */
function isNonWriteTargetPath(p: string): boolean {
  return /^\/(usr|bin|sbin|opt|System|Library|dev|proc|etc)\b/.test(p);
}

/** Absolute paths in a command that are neither the write target nor forbidden to write. */
function isIgnorableScanPath(p: string): boolean {
  return isNonWriteTargetPath(p) || isTempPath(p) || isUrlFragment(p);
}

/** True when a path-like string is actually a URL fragment (e.g. `//example.com/f`
 *  extracted from `https://example.com/f` by the absolute-path regex). */
function isUrlFragment(p: string): boolean {
  return p.startsWith('//') || /^\/[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}\//.test(p);
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
 * Evaluate confinement for `cwd-only` policy: writes inside cwd are allowed,
 * writes outside cwd are denied, reads are unrestricted.
 */
export function evaluateConfinement(toolName: string, toolInput: unknown, cwd: string): HookResult {
  const ti = (toolInput ?? {}) as { file_path?: unknown; notebook_path?: unknown; path?: unknown; command?: unknown };

  if (WRITE_TOOLS.has(toolName)) {
    const target = [ti.file_path, ti.notebook_path, ti.path].find((v) => typeof v === 'string') as string | undefined;
    // Temp is writable under this policy, so it is writable through EVERY tool. The Bash scan
    // already allowed it and this branch did not, which meant one policy had two boundaries: a
    // worker was refused `Write /tmp/scratch` and then permitted `echo … > /tmp/scratch`. The
    // looser path is the effective one whenever both tools are available, so the disagreement
    // bought no safety — only a confusing denial.
    if (target && !isTempPath(target) && pathEscapesCwd(target, cwd)) {
      return deny(
        `Write blocked: "${target}" is outside the task workspace (${cwd}). ` +
          `This task may only modify files inside that directory — make your change there.`,
      );
    }
    // FR-7: the workspace now IS the caller's real checkout, so `.git` is inside the writable
    // subtree for the first time. Corrupting it would destroy the caller's history.
    if (target && pathTouchesGitDir(target)) {
      return deny(
        `Write blocked: "${target}" is inside the repository's .git directory. ` +
          `Workers may not modify git metadata; the engine commits your work for you.`,
      );
    }
  }

  if (toolName === 'Bash' && typeof ti.command === 'string') {
    // FR-7 — worker git is default-deny (subcommands AND flags). Checked before the
    // path-escape scan because a denied git command is denied regardless of where it points.
    const gitDenial = gitDenialInCommand(ti.command);
    if (gitDenial) return deny(`Git blocked: ${gitDenial}`);

    const escape = bashWritesOutsideCwd(ti.command, cwd);
    if (escape) {
      return deny(
        `Bash write blocked: the command writes to "${escape}", outside the task workspace (${cwd}). ` +
          `Reads are fine, but only write inside the task workspace.`,
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
    // Listed from the set rather than spelled out: a hand-written list here is a further
    // copy, it goes stale silently, and it is the only statement of the rule the worker reads.
    return deny(
      `Write blocked: this is a read-only task. ${[...WRITE_TOOLS].join('/')} are not permitted.`,
    );
  }

  if (toolName === 'Bash' && typeof (toolInput as { command?: unknown })?.command === 'string') {
    const command = (toolInput as { command: string }).command;
    // A read-only task must be at least as restricted as a write task, so the same
    // default-deny git policy applies here too.
    const gitDenial = gitDenialInCommand(command);
    if (gitDenial) return deny(`Git blocked: ${gitDenial}`);

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
 * - `cwd-only`: confines writes to `cwd`, reads unrestricted. Needs the cwd, by definition.
 * - `read-only`: blocks all write tools regardless of path. Needs NO cwd — "no writes at all"
 *   is decidable without one, which is why `cwd` is optional here. The session used to install
 *   this hook only when a cwd was also present, so a read-only task without one ran with no
 *   write blocking whatsoever.
 */
export function buildConfinementHook(policy: SandboxPolicy, cwd?: string): {
  PreToolUse: { hooks: ((input: { tool_name: string; tool_input: unknown }) => Promise<HookResult>)[] }[];
} {
  const evaluator = policy === 'read-only' || cwd === undefined
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

