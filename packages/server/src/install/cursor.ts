/**
 * Cursor skill writer.
 *
 * Writes skill content to `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 * This path is CWD-relative (NOT home-relative), because Cursor rules live
 * in the project directory.
 *
 * Supports `@include _shared/<file>.md` directive inlining from skillsRoot.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CursorInstallOpts {
  /** Raw skill content (may include @include directives). */
  content: string;
  /** Working directory — replaces process.cwd() for the target path. */
  cwd: string;
  /** For @include resolution (skillsRoot or explicit path). */
  homeDir: string;
  /** Base directory for @include resolution. */
  skillsRoot: string;
  /** If true, overwrite an existing file. Defaults to false. */
  force?: boolean;
}

export interface CursorInstallResult {
  /** True if the file was written, false if it was skipped. */
  written: boolean;
  /** Full path to the file that was (or would have been) written. */
  targetPath: string;
}

/** Regex to match `@include _shared/<file>.md` lines. */
const INCLUDE_RE = /^@include _shared\/([^/\s]+\.md)\s*$/;

/**
 * Inline `@include _shared/<file>.md` directives in `content` with file
 * content from `<skillsRoot>/_shared/<file>.md`.
 *
 * Missing shared file → warn to stderr and skip the line.
 */
function inlineIncludes(content: string, skillsRoot: string, stderr: (s: string) => boolean): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }

    const filename = match[1];
    const sharedPath = path.join(skillsRoot, '_shared', filename);

    if (!fs.existsSync(sharedPath)) {
      stderr(`[cursor-install] Warning: @include '${filename}' not found in '${skillsRoot}/_shared/'; skipping line.\n`);
      continue;
    }

    try {
      const included = fs.readFileSync(sharedPath, 'utf-8');
      result.push(included);
    } catch (err) {
      stderr(`[cursor-install] Warning: could not read '${sharedPath}': ${err instanceof Error ? err.message : String(err)}; skipping line.\n`);
    }
  }

  return result.join('\n');
}

/**
 * Write the skill content to `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 *
 * - If the file exists and `force` is false → skip with a stderr warning.
 * - If the file exists and `force` is true → overwrite.
 * - If the file does not exist → create it (including parent dirs).
 *
 * @returns CursorInstallResult with `written: true` if the file was written.
 */
export function installCursor(opts: CursorInstallOpts): CursorInstallResult {
  const targetPath = path.join(opts.cwd, '.cursor', 'rules', 'multi-model-agent.mdc');

  if (fs.existsSync(targetPath) && !opts.force) {
    // Emit warning to stderr so callers can surface it in CLI output.
    process.stderr.write(
      `[cursor-install] Skill already installed at '${targetPath}'; skipping. ` +
      `Use --force to overwrite.\n`,
    );
    return { written: false, targetPath };
  }

  // Inline any @include directives before writing.
  const inlined = inlineIncludes(opts.content, opts.skillsRoot, (s: string) => {
    process.stderr.write(s);
  });

  // Ensure the rules directory exists.
  const rulesDir = path.dirname(targetPath);
  fs.mkdirSync(rulesDir, { recursive: true });

  fs.writeFileSync(targetPath, inlined, { encoding: 'utf-8' });

  return { written: true, targetPath };
}

/**
 * Remove `<cwd>/.cursor/rules/multi-model-agent.mdc`.
 *
 * If the file does not exist, this is a no-op (no error thrown).
 */
export function uninstallCursor(cwd: string): void {
  const targetPath = path.join(cwd, '.cursor', 'rules', 'multi-model-agent.mdc');
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath);
  }
}
