/**
 * Codex CLI skill writer for install-skill.
 *
 * Writes each skill's SKILL.md to `<homeDir>/.codex/skills/<skillName>/SKILL.md`.
 * Codex discovers skills from that directory on the next session start. Existing
 * `AGENTS.md` instructions are user-owned and are not modified by this writer.
 *
 * Before writing, any `@include _shared/<file>.md` directives are inlined using
 * the shared include utility. Missing shared files are warned about and omitted,
 * matching the other client writers.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

import { inlineIncludes } from './include-utils.js';

const LEGACY_MANAGED_BEGIN = '<!-- multi-model-agent:BEGIN -->';
const LEGACY_MANAGED_END = '<!-- multi-model-agent:END -->';

export interface CodexCliInstallOpts {
  /** Human-readable name of the skill (used in file path). */
  skillName: string;
  /** Raw skill content, possibly containing @include directives. */
  content: string;
  /**
   * Home directory — replaces `os.homedir()` in all file operations.
   * Must NOT default to `os.homedir()`.
   */
  homeDir: string;
  /** Root of the skills directory for @include resolution. */
  skillsRoot: string;
}

function codexSkillsBase(homeDir: string): string {
  return path.resolve(homeDir, '.codex', 'skills');
}

function resolveSkillDir(homeDir: string, skillName: string): string | null {
  const base = codexSkillsBase(homeDir);
  const resolved = path.resolve(base, path.normalize(skillName));
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function removeLegacyManagedAgentsBlock(homeDir: string): void {
  const agentsPath = path.join(homeDir, '.codex', 'AGENTS.md');
  let content: string;
  try {
    content = fs.readFileSync(agentsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const beginIdx = content.indexOf(LEGACY_MANAGED_BEGIN);
  const endIdx = content.indexOf(LEGACY_MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || beginIdx > endIdx) return;

  const suffixStart = endIdx + LEGACY_MANAGED_END.length;
  const prefix = content.slice(0, beginIdx);
  const suffix = content.slice(suffixStart).replace(/^\n+/, '');
  const nextContent = `${prefix}${suffix}`;

  if (nextContent.trim() === '') {
    fs.unlinkSync(agentsPath);
  } else {
    fs.writeFileSync(agentsPath, nextContent, 'utf-8');
  }
}

/**
 * Write (or overwrite) the SKILL.md file for a Codex CLI skill.
 *
 * Target path: `<homeDir>/.codex/skills/<skillName>/SKILL.md`
 */
export function installCodexCli(opts: CodexCliInstallOpts): void {
  const { skillName, content, homeDir, skillsRoot } = opts;
  const skillDir = resolveSkillDir(homeDir, skillName);
  if (skillDir === null) {
    throw new Error(`Invalid Codex CLI skill name: ${skillName}`);
  }

  removeLegacyManagedAgentsBlock(homeDir);
  const inlinedContent = inlineIncludes('Codex CLI skill writer', content, skillsRoot);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), inlinedContent, 'utf-8');
}

/**
 * Uninstall a Codex CLI skill by removing its directory.
 *
 * This is a no-op when the directory does not exist or when `skillName` would
 * escape the Codex skills directory.
 */
export function uninstallCodexCli(skillName: string, homeDir: string): void {
  removeLegacyManagedAgentsBlock(homeDir);
  const skillDir = resolveSkillDir(homeDir, skillName);
  if (skillDir === null) return;
  fs.rmSync(skillDir, { recursive: true, force: true });
}
