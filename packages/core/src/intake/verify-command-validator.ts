// v4.4.x — caller-supplied `verifyCommand` validator. Each entry is a
// shell command; each chained sub-command's argv[0] is checked against
// a read-only-git allowlist. `verifyCommand` is for *running tests*,
// not mutating the repo — Committing owns the commit.

const GIT_READONLY_ALLOWLIST = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'cat-file',
  'blame', 'rev-parse', 'describe', 'shortlog', 'whatchanged', 'name-rev',
]);

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

function tokenize(cmd: string): string[][] {
  return cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter((s) => s.length > 0).map((s) => s.split(/\s+/));
}

function isAllowedGitArgv(argv: string[]): boolean {
  if (argv[0] !== 'git') return true;
  if (argv.length < 2) return false;
  const sub = argv[1];
  if (GIT_READONLY_ALLOWLIST.has(sub)) return true;
  if (sub === 'config' && argv[2] === '--get') return true;
  if (sub === 'remote' && argv[2] === '-v') return true;
  return false;
}

export function validateVerifyCommand(verifyCommand: string[] | undefined): ValidationResult {
  if (!verifyCommand || verifyCommand.length === 0) return { ok: true };
  for (let i = 0; i < verifyCommand.length; i++) {
    const entry = verifyCommand[i];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { ok: false, error: `verifyCommand[${i}]: must be non-empty string` };
    }
    for (const argv of tokenize(entry)) {
      if (argv.length === 0) continue;
      if (argv[0] === 'git' && !isAllowedGitArgv(argv)) {
        return {
          ok: false,
          error: `verifyCommand[${i}]: git ${argv[1] ?? ''} is not allowed; only read-only git inspection subcommands are permitted`,
        };
      }
    }
  }
  return { ok: true };
}
