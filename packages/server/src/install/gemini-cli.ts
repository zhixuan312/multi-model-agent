/**
 * Gemini CLI skill writer.
 *
 * Writes to `<homeDir>/.gemini/extensions/multi-model-agent/`:
 * - `gemini-extension.json` — extension manifest
 * - `SKILL.md` — skill content (with @include directives inlined)
 *
 * The extension manifest schema is a reasonable minimal schema chosen based on
 * available documentation. Gemini CLI extension format is not fully standardized;
 * this implementation uses the most commonly documented shape:
 *   { name, version, description, schemaVersion, contextFiles }
 */
import fs from 'node:fs';
import path from 'node:path';

export interface GeminiCliInstallOpts {
  /** Skill name (currently unused — extension is always named 'multi-model-agent'). */
  skillName: string;
  /** Raw SKILL.md content (may contain @include directives). */
  content: string;
  /** Version string for the extension manifest. */
  skillVersion: string;
  /** Replaces os.homedir() in all path calculations. */
  homeDir: string;
  /**
   * Root directory containing skill source files.
   * Used for @include resolution (looks for `<skillsRoot>/_shared/<file>.md`).
   */
  skillsRoot: string;
}

/**
 * Inline @include directives in skill content.
 *
 * Replaces each line matching `@include _shared/<file>.md` with the contents
 * of `<skillsRoot>/_shared/<file>.md`. If the shared file is missing, writes
 * a warning to stderr and skips that line.
 *
 * Only the `@include` lines are replaced; all other content passes through unchanged.
 */
function inlineIncludes(content: string, skillsRoot: string, stderr: (s: string) => boolean): string {
  const includeRegex = /^@include _shared\/([^/\s]+)\.md\r?$/;
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const match = line.match(includeRegex);
    if (!match) {
      result.push(line);
      continue;
    }

    const filename = match[1] + '.md';
    const sharedPath = path.join(skillsRoot, '_shared', filename);

    try {
      const sharedContent = fs.readFileSync(sharedPath, 'utf-8');
      result.push(sharedContent.trimEnd());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      stderr(`[install-skill:gemini] Warning: @include '${filename}' not found in _shared/: ${detail}\n`);
      // Skip this line — do not include the @include directive in the output
    }
  }

  return result.join('\n');
}

/**
 * Install a skill to the Gemini CLI extensions directory.
 *
 * Writes two files to `<homeDir>/.gemini/extensions/multi-model-agent/`:
 * - `gemini-extension.json` — minimal extension manifest
 * - `SKILL.md` — skill content with @include directives inlined
 *
 * Idempotent: calling this function multiple times overwrites the extension files.
 *
 * @param opts - Installation options (see GeminiCliInstallOpts)
 */
export function installGeminiCli(opts: GeminiCliInstallOpts): void {
  const { skillName: _skillName, content, skillVersion, homeDir, skillsRoot } = opts;

  const extDir = path.join(homeDir, '.gemini', 'extensions', 'multi-model-agent');
  fs.mkdirSync(extDir, { recursive: true });

  // Write extension manifest
  const manifest = {
    name: 'multi-model-agent',
    version: skillVersion,
    description: 'multi-model-agent skills for Gemini CLI',
    schemaVersion: '1.0',
    contextFiles: ['SKILL.md'],
  };

  const manifestPath = path.join(extDir, 'gemini-extension.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  // Inline @include directives and write SKILL.md
  const stderr = (s: string) => process.stderr.write(s);
  const inlinedContent = inlineIncludes(content, skillsRoot, stderr);
  const skillPath = path.join(extDir, 'SKILL.md');
  fs.writeFileSync(skillPath, inlinedContent + '\n', 'utf-8');
}

/**
 * Uninstall the multi-model-agent extension from the Gemini CLI.
 *
 * Recursively removes `<homeDir>/.gemini/extensions/multi-model-agent/`.
 * If the directory does not exist, this function is a no-op.
 *
 * @param homeDir - Home directory path
 */
export function uninstallGeminiCli(homeDir: string): void {
  const extDir = path.join(homeDir, '.gemini', 'extensions', 'multi-model-agent');

  if (fs.existsSync(extDir)) {
    fs.rmSync(extDir, { recursive: true, force: true });
  }
}
