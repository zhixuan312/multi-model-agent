// Shared skill-install utilities. Per architecture.md:188-194, each client
// gets its own writer under skill-installers/; this file holds the dispatch
// layer, orchestration, missing-skill detection, and outbound headers/notify
// code that was previously scattered across packages/server/src/install/.
//
// @module
import fs from 'node:fs';
import path from 'node:path';
import type { Client, ManifestEntry } from './manifest.js';
import {
  SkillNotFoundError,
  getSkillsRoot,
  readSkillContent,
  SUPPORTED_SKILLS,
} from './discover.js';
import { installClaudeCode, uninstallClaudeCode, installClaudeCodeCommand, uninstallClaudeCodeCommand } from './skill-installers/claude-code.js';
import { installGeminiCli, uninstallGeminiCli } from './skill-installers/gemini-cli.js';
import { installCodexCli, uninstallCodexCli } from './skill-installers/codex-cli.js';
import { installCursor, uninstallCursor } from './skill-installers/cursor.js';

// ── Headers (was server/src/install/headers.ts) ───────────────────────────

export type HeaderClientName = 'claude-code' | 'cursor' | 'codex-cli' | 'gemini-cli';

export function clientHeaders(client: HeaderClientName) {
  return { 'X-MMA-Client': client };
}

export function toHeaderClientName(client: Client): HeaderClientName {
  switch (client) {
    case 'claude-code': return 'claude-code';
    case 'cursor':      return 'cursor';
    case 'codex':       return 'codex-cli';
    case 'gemini':      return 'gemini-cli';
  }
}

// ── Notify (was server/src/install/notify.ts) ──────────────────────────────

export function notifySkillInstalled(opts: {
  skillId: string;
  client: string;
  fetch?: typeof globalThis.fetch;
}): void {
  const headerClient = toHeaderClientName(opts.client as Parameters<typeof toHeaderClientName>[0]);
  const _fetch = opts.fetch ?? globalThis.fetch;
  _fetch('http://localhost:7331/v1/events', {
    method: 'POST',
    headers: { 'X-MMA-Client': headerClient, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'skill_installed', skillId: opts.skillId, client: opts.client }),
  }).catch(() => { /* fire-and-forget */ });
}

// ── Missing skills (was server/src/install/missing-skills.ts) ───────────────

export interface MissingSkill {
  name: string;
  targets: Client[];
}

export function findMissingSkills(
  manifestEntries: ManifestEntry[],
  supportedSkills: readonly string[],
): MissingSkill[] {
  if (manifestEntries.length === 0) return [];
  const targets = unionTargets(manifestEntries);
  if (targets.length === 0) return [];
  const installedNames = new Set(manifestEntries.map((e) => e.name));
  return supportedSkills
    .filter((name) => !installedNames.has(name))
    .map((name) => ({ name, targets: [...targets] }));
}

export function findOrphanedSkills(
  manifestEntries: ManifestEntry[],
  supportedSkills: readonly string[],
): ManifestEntry[] {
  return manifestEntries.filter((e) => !supportedSkills.includes(e.name));
}

function unionTargets(entries: ManifestEntry[]): Client[] {
  const seen = new Set<Client>();
  const out: Client[] = [];
  for (const e of entries) {
    for (const t of e.targets) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

// ── Per-client dispatch (was server/src/install/manifest-resolve.ts) ────────

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

export class UnknownTargetError extends Error {
  readonly code = 'unknown_target' as const;
  constructor(target: string, valid: readonly string[]) {
    super(`Unknown target '${target}'. Valid: ${valid.join(', ')}`);
  }
}

export function writeSkillToClient(
  skillName: string,
  content: string,
  target: Client,
  homeDir: string,
  skillsRoot: string,
  version: string = '0.0.0',
  cwd: string = process.cwd(),
  force: boolean = false,
  authToken?: string,
): void {
  switch (target) {
    case 'claude-code':
      installClaudeCode({ skillName, content, homeDir, skillsRoot, authToken });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'gemini':
      installGeminiCli({ skillName, content, skillVersion: version, homeDir, skillsRoot, authToken });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'codex':
      installCodexCli({ skillName, content, homeDir, skillsRoot, authToken });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    case 'cursor':
      installCursor({ content, cwd, homeDir, skillsRoot, force, authToken });
      notifySkillInstalled({ skillId: skillName, client: target });
      break;
    default: {
      const _exhaustive: never = target;
      throw new Error(`install-skill: unknown target: ${_exhaustive as string}`);
    }
  }
}

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

// ── Claude Code commands (explicit /slash-command invocation) ────────────────

export function writeCommandToClaudeCode(
  commandName: string,
  content: string,
  homeDir: string,
  skillsRoot: string,
  authToken?: string,
): void {
  installClaudeCodeCommand({ commandName, content, homeDir, skillsRoot, authToken });
}

export function removeCommandFromClaudeCode(
  commandName: string,
  homeDir: string,
): void {
  uninstallClaudeCodeCommand(commandName, homeDir);
}

// ── Orchestration (was server/src/install/orchestrate.ts) ───────────────────

export function activeCleanup(installDir: string, canonicalSkills: readonly string[]): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(installDir);
  } catch {
    return [];
  }
  const present = entries.filter((name) => name.startsWith('mma-'));
  const orphaned = present.filter((name) => !canonicalSkills.includes(name));
  for (const orphan of orphaned) {
    const dirPath = path.join(installDir, orphan);
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  return orphaned;
}
