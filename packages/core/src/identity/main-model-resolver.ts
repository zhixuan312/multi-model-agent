import * as fs from 'node:fs';
import * as path from 'node:path';

export type SupportedClient = 'claude-code' | 'codex-cli' | 'cursor' | 'gemini-cli';

export interface ResolveInputs {
  headerValue: string | undefined;
  client: SupportedClient;
  cwd: string;
  configDefaultMainModel: string | undefined;
  homeDir: string;
}

export interface ResolveResult {
  model: string;
  source: 'header' | 'auto:claude-code' | 'auto:codex-cli' | 'config' | 'unknown';
}

const SENTINEL = 'unknown_main_model';

export function resolveMainModel(inputs: ResolveInputs): ResolveResult {
  if (inputs.headerValue && inputs.headerValue.trim().length > 0) {
    return { model: inputs.headerValue.trim(), source: 'header' };
  }
  if (inputs.client === 'claude-code') {
    const m = resolveClaudeCode(inputs.cwd, inputs.homeDir);
    if (m) return { model: m, source: 'auto:claude-code' };
  } else if (inputs.client === 'codex-cli') {
    const m = resolveCodexCli(inputs.homeDir);
    if (m) return { model: m, source: 'auto:codex-cli' };
  }
  if (inputs.configDefaultMainModel && inputs.configDefaultMainModel.trim().length > 0) {
    return { model: inputs.configDefaultMainModel.trim(), source: 'config' };
  }
  return { model: SENTINEL, source: 'unknown' };
}

function resolveClaudeCode(cwd: string, homeDir: string): string | null {
  const slug = cwd.replace(/\//g, '-');
  const projectsDir = path.join(homeDir, '.claude', 'projects', slug);
  let entries: string[];
  try { entries = fs.readdirSync(projectsDir); } catch { return null; }
  const jsonls = entries.filter(e => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;
  let latest: string | null = null;
  let latestMtime = -1;
  for (const j of jsonls) {
    try {
      const m = fs.statSync(path.join(projectsDir, j)).mtimeMs;
      if (m > latestMtime) { latestMtime = m; latest = j; }
    } catch { /* skip */ }
  }
  if (!latest) return null;
  let content: string;
  try { content = fs.readFileSync(path.join(projectsDir, latest), 'utf8'); } catch { return null; }
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed && typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
        return parsed.model.trim();
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

function resolveCodexCli(homeDir: string): string | null {
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  let content: string;
  try { content = fs.readFileSync(configPath, 'utf8'); } catch { return null; }
  const match = content.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
  if (!match) return null;
  return match[1]!.trim() || null;
}
