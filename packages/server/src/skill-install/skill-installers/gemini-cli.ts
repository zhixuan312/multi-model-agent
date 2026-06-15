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
 * are replaced via the shared `inlineIncludes` helper (the same one
 * Claude/Codex/Cursor use). That helper enforces the `_shared/` prefix,
 * rejects path traversal, suppresses only ENOENT (missing file → warn + drop),
 * and re-throws other I/O errors.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { inlineIncludes } from '../include-utils.js';

/**
 * Options for installing a skill via the Gemini CLI writer.
 */
export interface GeminiCliInstallOpts {
  skillName: string;
  content: string;
  skillVersion: string;
  homeDir: string;
  skillsRoot: string;
  authToken?: string;
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
  const { skillName: _skillName, content, skillVersion, homeDir, skillsRoot, authToken } = opts;

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
  const finalContent = inlineIncludes('Gemini CLI skill writer', content, skillsRoot, authToken);
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