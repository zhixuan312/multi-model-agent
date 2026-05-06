// Per-client install/uninstall dispatch — resolves a target client to the
// concrete writer/remover pair. Extracted from cli/install-skill.ts as
// part of Ch 7 Task 39.
import path from 'node:path';
import type { Client } from '@zhixuan92/multi-model-agent-core/tool-surface/manifest';
import { notifySkillInstalled } from './notify.js';
import { installClaudeCode, uninstallClaudeCode } from '@zhixuan92/multi-model-agent-core/tool-surface/skill-installers/claude-code';
import { installGeminiCli, uninstallGeminiCli } from '@zhixuan92/multi-model-agent-core/tool-surface/skill-installers/gemini-cli';
import { installCodexCli, uninstallCodexCli } from '@zhixuan92/multi-model-agent-core/tool-surface/skill-installers/codex-cli';
import { installCursor, uninstallCursor } from '@zhixuan92/multi-model-agent-core/tool-surface/skill-installers/cursor';

/**
 * Return the per-client install directory where skills are written as
 * subdirectories. Only claude-code and codex use the per-skill directory
 * model; gemini and cursor use a single file/extension and return null.
 */
export function resolveClientInstallDir(target: Client, homeDir: string): string | null {
  switch (target) {
    case 'claude-code':
      return path.join(homeDir, '.claude', 'skills');
    case 'codex':
      return path.join(homeDir, '.codex', 'skills');
    default:
      return null;
  }
}

/** Thrown when a passed `--target` value is not a known client. */
export class UnknownTargetError extends Error {
  readonly code = 'unknown_target' as const;
  constructor(target: string, valid: readonly Client[]) {
    super(`Unknown target: ${target}. Valid: ${valid.join(', ')}`);
  }
}

/** Dispatch a write to the appropriate per-client installer. */
export function writeSkillToClient(
  skillName: string,
  content: string,
  target: Client,
  homeDir: string,
  skillsRoot: string,
  version: string = '0.0.0',
  cwd: string = process.cwd(),
  force: boolean = false,
): void {
  switch (target) {
    case 'claude-code':
      installClaudeCode({ skillName, content, homeDir, skillsRoot });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'gemini':
      installGeminiCli({ skillName, content, skillVersion: version, homeDir, skillsRoot });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'codex':
      installCodexCli({ skillName, content, homeDir, skillsRoot });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'cursor':
      installCursor({ content, cwd, homeDir, skillsRoot, force });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    default: {
      const _exhaustive: never = target;
      throw new Error(`install-skill: unknown target: ${_exhaustive as string}`);
    }
  }
}

/** Dispatch an uninstall to the appropriate per-client remover. */
export function removeSkillFromClient(
  skillName: string,
  target: Client,
  homeDir: string,
  cwd: string = process.cwd(),
): void {
  switch (target) {
    case 'claude-code':
      uninstallClaudeCode(skillName, homeDir);
      break;
    case 'gemini':
      uninstallGeminiCli(homeDir);
      break;
    case 'codex':
      uninstallCodexCli(skillName, homeDir);
      break;
    case 'cursor':
      uninstallCursor(cwd);
      break;
    default: {
      const _exhaustive: never = target;
      throw new Error(`install-skill: unknown target: ${_exhaustive as string}`);
    }
  }
}
