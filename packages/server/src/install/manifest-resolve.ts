// Per-client install/uninstall dispatch — resolves a target client to the
// concrete writer/remover pair. Extracted from cli/install-skill.ts as
// part of Ch 7 Task 39.
import type { Client } from './manifest.js';
import { installClaudeCode, uninstallClaudeCode } from './claude-code.js';
import { installGeminiCli, uninstallGeminiCli } from './gemini-cli.js';
import { installCodexCli, uninstallCodexCli } from './codex-cli.js';
import { installCursor, uninstallCursor } from './cursor.js';

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
      break;
    case 'gemini':
      installGeminiCli({ skillName, content, skillVersion: version, homeDir, skillsRoot });
      break;
    case 'codex':
      installCodexCli({ skillName, content, homeDir, skillsRoot });
      break;
    case 'cursor':
      installCursor({ content, cwd, homeDir, skillsRoot, force });
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
      uninstallCodexCli(homeDir);
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
