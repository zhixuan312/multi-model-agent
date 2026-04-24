/**
 * Gemini CLI skill writer.
 *
 * Writes to `<homeDir>/.gemini/extensions/multi-model-agent/`:
 *   - `gemini-extension.json`  — extension manifest
 *   - `SKILL.md`               — skill content (with @include directives inlined)
 *
 * The extension is always named `multi-model-agent` regardless of `skillName`
 * (the extension loads whichever skill files are provided).  This is a
 * judgment call because the Gemini CLI extension format is not fully
 * standardized; a minimal JSON schema is used.
 *
 * Before writing SKILL.md, any `@include _shared/<file>.md` directive lines
 * are replaced with the file content from `<skillsRoot>/_shared/<file>.md`.
 * Missing shared files → warning to stderr, line is dropped.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

/** Regex matching a line that starts with `@include ` followed by a relative path. */
const INCLUDE_RE = /^@include\s+(.+)$/;

/**
 * Options for installing a skill via the Gemini CLI writer.
 */
export interface GeminiCliInstallOpts {
  /** Skill name (currently informational; writes always go to multi-model-agent extension). */
  skillName: string;
  /**
   * Raw SKILL.md content. May contain `@include _shared/<file>.md` directives
   * which are inlined before writing.
   */
  content: string;
  /**
   * Version string for the extension manifest's `version` field.
   */
  skillVersion: string;
  /**
   * The "home directory" that replaces `os.homedir()`.
   * Must NOT default to `os.homedir()` — always required explicitly.
   */
  homeDir: string;
  /**
   * Where shared files live. The writer reads `<skillsRoot>/_shared/<file>.md`
   * when inlining `@include` directives.
   */
  skillsRoot: string;
}

/**
 * Inline `@include _shared/<file>.md` directives in `content`.
 *
 * Each line matching `@include <path>` (space after `@include`) is replaced with
 * the full content of `<skillsRoot>/_shared/<path>`.
 *
 * If a shared file is missing:
 * - A warning is written to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining directives.
 *
 * @param content     Raw SKILL.md content (may contain @include directives).
 * @param skillsRoot  Root directory containing `_shared/` sub-directory.
 * @returns The content with directives inlined.
 */
export function inlineIncludes(content: string, skillsRoot: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }

    const relativePath = match[1]!;
    const sharedFilePath = path.join(skillsRoot, relativePath);

    try {
      const sharedContent = fs.readFileSync(sharedFilePath, 'utf-8');
      result.push(sharedContent);
    } catch (err) {
      // Log warning to stderr and drop the include line.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Warning: Gemini CLI skill writer: shared file not found: ` +
        `${sharedFilePath} (referenced by @include ${relativePath}) — ${detail}\n`,
      );
      // Line is dropped — do not push anything.
    }
  }

  return result.join('\n');
}

/**
 * Install a skill to the Gemini CLI extensions directory.
 *
 * Writes two files into `<homeDir>/.gemini/extensions/multi-model-agent/`:
 *   1. `gemini-extension.json` — the extension manifest
 *   2. `SKILL.md` — the skill content with @include directives inlined
 *
 * The directory (and any parent directories) are created with mode `0o700`.
 * Calling this function multiple times overwrites the previous installation
 * (idempotent).
 *
 * @param opts  Installation options (see `GeminiCliInstallOpts`).
 */
export function installGeminiCli(opts: GeminiCliInstallOpts): void {
  const { skillName: _skillName, content, skillVersion, homeDir, skillsRoot } = opts;

  const extDir = path.join(homeDir, '.gemini', 'extensions', 'multi-model-agent');
  fs.mkdirSync(extDir, { recursive: true, mode: 0o700 });

  // Write the extension manifest.
  // Shape is a minimal reasonable schema; Gemini CLI extension format is not
  // fully standardized, so we document this judgment call.
  const manifest = {
    name: 'multi-model-agent',
    version: skillVersion,
    description: 'multi-model-agent skills for Gemini CLI',
    schemaVersion: '1.0',
    contextFiles: ['SKILL.md'],
  };
  const manifestPath = path.join(extDir, 'gemini-extension.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  // Write the skill content with @include directives inlined.
  const finalContent = inlineIncludes(content, skillsRoot);
  const skillPath = path.join(extDir, 'SKILL.md');
  fs.writeFileSync(skillPath, finalContent, 'utf-8');
}

/**
 * Uninstall the multi-model-agent Gemini CLI extension.
 *
 * Recursively removes `<homeDir>/.gemini/extensions/multi-model-agent/`.
 * This is a no-op when the directory does not exist (no error is thrown).
 *
 * @param homeDir  The "home directory" that replaces `os.homedir()`.
 */
export function uninstallGeminiCli(homeDir: string): void {
  const extDir = path.join(homeDir, '.gemini', 'extensions', 'multi-model-agent');
  if (fs.existsSync(extDir)) {
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}