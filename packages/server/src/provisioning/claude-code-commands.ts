/**
 * Claude Code SDLC command assets (`/mma-flow`, `/mma-breakout`).
 *
 * Commands are a DIFFERENT asset class from skills: they live at
 * `<homeDir>/.claude/commands/<name>.md`, are explicitly invoked via
 * `/<name>` (never auto-matched by intent), and — unlike everything else
 * this release moved onto the ownership-safe provisioning port — are not
 * part of any `ClientCapability`'s skill root. This module is their sole
 * remaining home: the legacy `skill-install/skill-installer-common.ts` and
 * `skill-install/skill-installers/claude-code.ts` that used to own them were
 * retired with the rest of the per-client installers, and this capability was
 * moved here rather than dropped along with them.
 *
 * Deliberately raw filesystem writes (mirroring the pre-I-8 behaviour) —
 * NOT the ownership-safe skill primitives in `owned-files.ts`: a command
 * file is a single Markdown file with an adjacent workflow-script manifest,
 * not a directory this or a sibling client shares, so there is no
 * shared-root reference-counting concern the ownership machinery exists for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inlineIncludes } from '../skill-install/include-utils.js';

function workflowDirFor(homeDir: string): string {
  return path.join(homeDir, '.claude', 'workflows');
}

function workflowManifestPath(homeDir: string, commandName: string): string {
  return path.join(workflowDirFor(homeDir), `.${commandName}.json`);
}

function packagedWorkflowDir(skillsRoot: string, commandName: string): string {
  return path.join(skillsRoot, commandName, 'workflows');
}

function listPackagedWorkflowFiles(skillsRoot: string, commandName: string): string[] {
  const dir = packagedWorkflowDir(skillsRoot, commandName);
  try {
    return fs.readdirSync(dir)
      .filter((fileName) => fileName.endsWith('.js'))
      .sort();
  } catch {
    return [];
  }
}

function readWorkflowManifest(homeDir: string, commandName: string): string[] {
  try {
    const raw = fs.readFileSync(workflowManifestPath(homeDir, commandName), 'utf-8');
    const parsed = JSON.parse(raw) as { files?: string[] };
    return Array.isArray(parsed.files) ? parsed.files.filter((fileName) => typeof fileName === 'string') : [];
  } catch {
    return [];
  }
}

function writeWorkflowManifest(homeDir: string, commandName: string, files: string[]): void {
  if (files.length === 0) return;
  fs.mkdirSync(workflowDirFor(homeDir), { recursive: true });
  fs.writeFileSync(
    workflowManifestPath(homeDir, commandName),
    JSON.stringify({ skillName: commandName, files }, null, 2) + '\n',
    'utf-8',
  );
}

function syncPackagedWorkflows(homeDir: string, skillsRoot: string, commandName: string): void {
  const fileNames = listPackagedWorkflowFiles(skillsRoot, commandName);
  const previousFiles = readWorkflowManifest(homeDir, commandName);
  const targetDir = workflowDirFor(homeDir);

  if (fileNames.length === 0) {
    for (const stale of previousFiles) {
      fs.rmSync(path.join(targetDir, stale), { force: true });
    }
    fs.rmSync(workflowManifestPath(homeDir, commandName), { force: true });
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  for (const stale of previousFiles) {
    if (!fileNames.includes(stale)) {
      fs.rmSync(path.join(targetDir, stale), { force: true });
    }
  }

  for (const fileName of fileNames) {
    const sourcePath = path.join(packagedWorkflowDir(skillsRoot, commandName), fileName);
    const targetPath = path.join(targetDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
  }

  writeWorkflowManifest(homeDir, commandName, fileNames);
}

/**
 * Write (or overwrite) a Claude Code command file and sync its packaged
 * workflow scripts.
 *
 * Target path: `<homeDir>/.claude/commands/<commandName>.md`
 */
export function writeCommandToClaudeCode(
  commandName: string,
  content: string,
  homeDir: string,
  skillsRoot: string,
): void {
  const inlinedContent = inlineIncludes('Claude Code command writer', content, skillsRoot);

  const commandsDir = path.join(homeDir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, `${commandName}.md`), inlinedContent, 'utf-8');
  syncPackagedWorkflows(homeDir, skillsRoot, commandName);
}

/**
 * Remove a Claude Code command file and its synced workflow assets.
 */
export function removeCommandFromClaudeCode(commandName: string, homeDir: string): void {
  const targetDir = workflowDirFor(homeDir);
  for (const fileName of readWorkflowManifest(homeDir, commandName)) {
    fs.rmSync(path.join(targetDir, fileName), { force: true });
  }
  fs.rmSync(workflowManifestPath(homeDir, commandName), { force: true });

  const commandFile = path.join(homeDir, '.claude', 'commands', `${commandName}.md`);
  fs.rmSync(commandFile, { force: true });
}

/**
 * Remove a standalone (pre-ownership-tracking) Claude Code skill directory
 * by raw path, with a traversal guard. Used ONLY by the plugin-supersedes-
 * standalone retirement path (`cli/sync-skills.ts`): that retirement predates
 * — and is orthogonal to — the ownership-marker system in `owned-files.ts`,
 * so it must not be gated by an ownership proof a pre-I-4 standalone install
 * never had.
 */
export function removeStandaloneClaudeCodeSkill(skillName: string, homeDir: string): void {
  const skillsBase = path.resolve(homeDir, '.claude', 'skills');
  const normalizedName = path.normalize(skillName);
  const resolvedSkillDir = path.resolve(skillsBase, normalizedName);
  const baseResolved = skillsBase + path.sep;
  if (!resolvedSkillDir.startsWith(baseResolved)) return;
  fs.rmSync(resolvedSkillDir, { recursive: true, force: true });
}
