// Codex native skill delivery. The staged root already holds `skills/<name>/`
// — exactly what codex reads at `$CODEX_HOME/skills`. So the staged root IS
// the ephemeral CODEX_HOME. For OAuth (subscription) auth, codex reads
// `$CODEX_HOME/auth.json`, so we symlink it to the real one (write-through
// keeps token refresh working). For env-key auth, codex reads the key from
// env and no auth.json is needed.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';

export type CodexAuthMode = 'oauth' | 'env-key';

export interface PrepareCodexSkillHomeInput {
  stagedRoot: string;
  authMode: CodexAuthMode;
  /** Defaults to $CODEX_HOME or ~/.codex. */
  realCodexHome?: string;
}

/** Arrange the staged root as an ephemeral CODEX_HOME and return its path. */
export async function prepareCodexSkillHome(input: PrepareCodexSkillHomeInput): Promise<string> {
  const { stagedRoot, authMode } = input;
  if (authMode === 'oauth') {
    const realHome = input.realCodexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    await symlink(join(realHome, 'auth.json'), join(stagedRoot, 'auth.json'));
  }
  return stagedRoot;
}

/** env-key when an explicit API key/env is configured; OAuth otherwise. */
export function codexAuthMode(cfg: { apiKey?: string; apiKeyEnv?: string }): CodexAuthMode {
  return cfg.apiKey || cfg.apiKeyEnv ? 'env-key' : 'oauth';
}
