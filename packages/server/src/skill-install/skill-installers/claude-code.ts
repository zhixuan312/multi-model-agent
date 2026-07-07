/**
 * Claude Code skill writer for install-skill.
 *
 * Writes each skill's SKILL.md to `<homeDir>/.claude/skills/<skillName>/SKILL.md`.
 *
 * Before writing, inlines any `@include _shared/<file>.md` directives found in
 * the content. The directive line is replaced with the full content of the
 * corresponding shared file sourced from `<skillsRoot>/_shared/<file>.md`.
 * The `@include` directive is NOT preserved in the written file.
 *
 * If a referenced shared file is missing (ENOENT):
 * - A warning is logged to stderr.
 * - The include line is removed from the output (not preserved).
 * - Processing continues for remaining content.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

import { inlineIncludes } from '../include-utils.js';

/**
 * Options for installing a Claude Code skill.
 */
export interface ClaudeCodeInstallOpts {
  skillName: string;
  content: string;
  homeDir: string;
  skillsRoot: string;
  authToken?: string;
}

function workflowDirFor(homeDir: string): string {
  return path.join(homeDir, '.claude', 'workflows');
}

function workflowManifestPath(homeDir: string, skillName: string): string {
  return path.join(workflowDirFor(homeDir), `.${skillName}.json`);
}

function packagedWorkflowDir(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'workflows');
}

function listPackagedWorkflowFiles(skillsRoot: string, skillName: string): string[] {
  const dir = packagedWorkflowDir(skillsRoot, skillName);
  try {
    return fs.readdirSync(dir)
      .filter((fileName) => fileName.endsWith('.js'))
      .sort();
  } catch {
    return [];
  }
}

function readWorkflowManifest(homeDir: string, skillName: string): string[] {
  try {
    const raw = fs.readFileSync(workflowManifestPath(homeDir, skillName), 'utf-8');
    const parsed = JSON.parse(raw) as { files?: string[] };
    return Array.isArray(parsed.files) ? parsed.files.filter((fileName) => typeof fileName === 'string') : [];
  } catch {
    return [];
  }
}

function writeWorkflowManifest(homeDir: string, skillName: string, files: string[]): void {
  if (files.length === 0) return;
  fs.mkdirSync(workflowDirFor(homeDir), { recursive: true });
  fs.writeFileSync(
    workflowManifestPath(homeDir, skillName),
    JSON.stringify({ skillName, files }, null, 2) + '\n',
    'utf-8',
  );
}

function syncPackagedWorkflows(homeDir: string, skillsRoot: string, skillName: string): void {
  const fileNames = listPackagedWorkflowFiles(skillsRoot, skillName);
  const previousFiles = readWorkflowManifest(homeDir, skillName);
  const targetDir = workflowDirFor(homeDir);

  if (fileNames.length === 0) {
    for (const stale of previousFiles) {
      fs.rmSync(path.join(targetDir, stale), { force: true });
    }
    fs.rmSync(workflowManifestPath(homeDir, skillName), { force: true });
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  for (const stale of previousFiles) {
    if (!fileNames.includes(stale)) {
      fs.rmSync(path.join(targetDir, stale), { force: true });
    }
  }

  for (const fileName of fileNames) {
    const sourcePath = path.join(packagedWorkflowDir(skillsRoot, skillName), fileName);
    const targetPath = path.join(targetDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
  }

  writeWorkflowManifest(homeDir, skillName, fileNames);
}

/**
 * Write (or overwrite) the SKILL.md file for a Claude Code skill.
 *
 * Target path: `<homeDir>/.claude/skills/<skillName>/SKILL.md`
 *
 * @param opts  Installation options (see `ClaudeCodeInstallOpts`).
 */
export function installClaudeCode(opts: ClaudeCodeInstallOpts): void {
  const { skillName, content, homeDir, skillsRoot, authToken } = opts;

  const inlinedContent = inlineIncludes('Claude Code skill writer', content, skillsRoot, authToken);

  // Determine target path: <homeDir>/.claude/skills/<skillName>/SKILL.md
  const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), inlinedContent, 'utf-8');
  syncPackagedWorkflows(homeDir, skillsRoot, skillName);
}

/**
 * Options for installing a Claude Code command.
 */
export interface ClaudeCodeCommandOpts {
  commandName: string;
  content: string;
  homeDir: string;
  skillsRoot: string;
  authToken?: string;
}

/**
 * Write (or overwrite) a command file for Claude Code.
 *
 * Target path: `<homeDir>/.claude/commands/<commandName>.md`
 *
 * Commands are explicitly invoked by the user via `/<commandName>`.
 * Also syncs any packaged workflow scripts for the command.
 */
export function installClaudeCodeCommand(opts: ClaudeCodeCommandOpts): void {
  const { commandName, content, homeDir, skillsRoot, authToken } = opts;

  const inlinedContent = inlineIncludes('Claude Code command writer', content, skillsRoot, authToken);

  const commandsDir = path.join(homeDir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, `${commandName}.md`), inlinedContent, 'utf-8');
  syncPackagedWorkflows(homeDir, skillsRoot, commandName);
}

/**
 * Uninstall a Claude Code command by removing its file and workflow assets.
 */
export function uninstallClaudeCodeCommand(commandName: string, homeDir: string): void {
  const targetDir = workflowDirFor(homeDir);
  for (const fileName of readWorkflowManifest(homeDir, commandName)) {
    fs.rmSync(path.join(targetDir, fileName), { force: true });
  }
  fs.rmSync(workflowManifestPath(homeDir, commandName), { force: true });

  const commandFile = path.join(homeDir, '.claude', 'commands', `${commandName}.md`);
  fs.rmSync(commandFile, { force: true });
}

/**
 * Uninstall a Claude Code skill by removing its directory.
 *
 * Target: `<homeDir>/.claude/skills/<skillName>/`
 *
 * Security: `skillName` is validated against the expected skills directory
 * boundary to prevent path traversal (e.g. `../other-dir`). If `skillName`
 * resolves outside the skills directory, the function is a no-op.
 *
 * This is also a no-op when the directory does not exist (no error is thrown).
 *
 * @param skillName  Name of the skill to uninstall.
 * @param homeDir    Home directory where the skill directory lives.
 */
export function uninstallClaudeCode(skillName: string, homeDir: string): void {
  const skillsBase = path.resolve(homeDir, '.claude', 'skills');
  const targetDir = workflowDirFor(homeDir);
  for (const fileName of readWorkflowManifest(homeDir, skillName)) {
    fs.rmSync(path.join(targetDir, fileName), { force: true });
  }
  fs.rmSync(workflowManifestPath(homeDir, skillName), { force: true });

  // Security: validate skillName does not escape the skills directory.
  // Normalize skillName and verify the resolved path stays within the base.
  const normalizedName = path.normalize(skillName);
  const resolvedSkillDir = path.resolve(skillsBase, normalizedName);
  const baseResolved = skillsBase + path.sep;
  if (!resolvedSkillDir.startsWith(baseResolved)) {
    // skillName traversal attempt — no-op rather than throwing, matching
    // the "no error when directory does not exist" behaviour.
    return;
  }

  fs.rmSync(resolvedSkillDir, { recursive: true, force: true });
}