/**
 * The shared worker git policy (FR-7). ONE definition; Claude's PreToolUse hook and Codex's
 * launch guard both derive from it, so the two runners cannot drift.
 *
 * Why this exists: write routes used to run inside a throwaway git worktree, so the caller's
 * real `.git` sat OUTSIDE the worker's writable subtree and a misbehaving worker could only
 * damage a directory we were about to delete. Running in place puts the caller's real `.git`
 * inside that subtree, where `git reset --hard` or `git checkout .` destroys actual work.
 *
 * Workers lose nothing: the engine commits server-side, outside every sandbox, and no skill
 * instructs a worker to run git.
 *
 * Two independent rules, because they close two different holes:
 *   1. SUBCOMMAND allow-list — only four read-only subcommands may run.
 *   2. FLAG allow-list — even an allowed subcommand can be turned into arbitrary code
 *      execution (`git -c core.pager='sh -c …' log`, `git log --show-signature` invoking a
 *      configured `gpg.program`). Enumerating bad flags is unwinnable, so unknown flags deny.
 *
 * Both are DEFAULT-DENY. A subcommand or flag nobody has thought of — including ones added by
 * future git versions — is denied, not allowed by omission.
 */

/** The only git subcommands a worker may run. Everything else is denied. */
const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show']);

/** The only flags permitted on an allowed subcommand. Everything else is denied. */
const ALLOWED_GIT_FLAGS = new Set([
  '--porcelain', '--short', '-s',
  '--oneline', '--stat', '--numstat', '--shortstat',
  '--name-only', '--name-status',
  '--cached', '--staged',
  '--graph', '--decorate', '--abbrev-commit',
  '--no-color', '--color=never',
  '--',
]);

/** Flags that take a value and are safe in the `--flag=value` / `-n 5` forms. */
const ALLOWED_GIT_VALUE_FLAGS = new Set(['-n', '--max-count', '--format', '--pretty', '--since', '--until']);

/** Global options that select the repository but do not alter execution behaviour. */
const ALLOWED_GLOBAL_VALUE_OPTS = new Set(['-C']);

export type GitDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOW: GitDecision = { allowed: true };

function deny(reason: string): GitDecision {
  return { allowed: false, reason };
}

/**
 * Decide a single `git …` invocation from its already-tokenized argv (excluding the leading
 * `git`). Exported for direct unit testing of both runners against one scenario matrix.
 */
export function evaluateGitArgv(argv: readonly string[]): GitDecision {
  let i = 0;

  // --- global options, before the subcommand ---
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const tok = argv[i]!;

    // `-c key=value` and `--config-env` inject configuration — the primary code-execution
    // vector (core.pager, diff.external, gpg.program, credential helpers).
    if (tok === '-c' || tok === '--config-env' || tok.startsWith('-c=') || tok.startsWith('--config-env=')) {
      return deny('git config injection (-c / --config-env) is not permitted — it can execute arbitrary programs');
    }
    // Each of these redirects git to an operator-chosen binary or path.
    if (tok.startsWith('--exec-path') || tok.startsWith('--upload-pack') || tok.startsWith('--receive-pack')
      || tok.startsWith('--git-dir') || tok.startsWith('--work-tree') || tok.startsWith('--namespace')) {
      return deny(`git global option "${tok}" is not permitted`);
    }
    if (ALLOWED_GLOBAL_VALUE_OPTS.has(tok)) {
      i += 2; // consume the option and its value
      continue;
    }
    if (tok === '--no-pager' || tok === '-P') { i += 1; continue; }
    return deny(`unrecognized git global option "${tok}" — worker git is default-deny`);
  }

  if (i >= argv.length) return deny('bare `git` with no subcommand is not permitted');

  const sub = argv[i]!;
  if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    return deny(
      `git "${sub}" is not permitted — workers may only run ${[...ALLOWED_GIT_SUBCOMMANDS].join(', ')}. `
      + 'The engine commits your work for you; do not use git directly.',
    );
  }
  i += 1;

  // --- flags on the allowed subcommand ---
  let afterDoubleDash = false;
  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (afterDoubleDash) continue;      // everything past `--` is a pathspec
    if (tok === '--') { afterDoubleDash = true; continue; }
    if (!tok.startsWith('-')) continue; // a ref or pathspec

    const base = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
    if (ALLOWED_GIT_FLAGS.has(tok) || ALLOWED_GIT_FLAGS.has(base)) continue;
    if (ALLOWED_GIT_VALUE_FLAGS.has(base)) {
      if (!tok.includes('=')) i += 1; // consume the separate value token
      continue;
    }
    return deny(
      `git flag "${tok}" is not permitted on "${sub}" — worker git flags are default-deny `
      + 'because flags such as --show-signature or --ext-diff execute externally configured programs',
    );
  }

  return ALLOW;
}

/** Split a shell command into whitespace-separated tokens, honouring simple quoting. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Scan a (possibly chained) shell command for a git invocation and return the first denial.
 * Returns null when the command contains no git invocation, or every one is permitted.
 */
export function gitDenialInCommand(command: string): string | null {
  // Split on shell chain/pipe operators so `foo && git reset --hard` is caught.
  const segments = command.split(/(?:&&|\|\||[;|]|\n)/);
  for (const segment of segments) {
    const tokens = tokenize(segment.trim());
    // Skip leading env assignments (`GIT_DIR=… git …`) and `env`/`sudo`-style prefixes.
    let start = 0;
    while (start < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!) || tokens[start] === 'env' || tokens[start] === 'sudo')) {
      start += 1;
    }
    const head = tokens[start];
    if (head === undefined) continue;
    // Match `git` and any path ending in `/git`.
    if (head !== 'git' && !head.endsWith('/git')) continue;

    const decision = evaluateGitArgv(tokens.slice(start + 1));
    if (!decision.allowed) return decision.reason;
  }
  return null;
}

/** True when a path (relative or absolute) reaches into a `.git` directory. */
export function pathTouchesGitDir(p: string): boolean {
  if (!p) return false;
  const normalized = p.replace(/\\/g, '/');
  return normalized === '.git' || normalized.startsWith('.git/') || /(^|\/)\.git(\/|$)/.test(normalized);
}
