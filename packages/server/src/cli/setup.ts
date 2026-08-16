/**
 * `mma setup` — the one interactive command.
 *
 * The whole first-run story is meant to be two lines:
 *
 *     npm i -g @zhixuan92/multi-model-agent
 *     mma setup
 *
 * and from then on just `npm i -g …` — the postinstall re-runs `sync-skills`
 * against the roster this command recorded, so upgrades refresh skills with
 * nothing typed.
 *
 * WHY ONE COMMAND. Before this, a new user had to discover that `clients.<id>`
 * existed in a config file, write it by hand, and only then would `sync-skills`
 * do anything — it dead-ended on a fresh machine with "No clients declared".
 * Splitting that across `enable`, `sync-skills` and `mcp install` gave three
 * commands with overlapping effects and no obvious entry point. Those still
 * exist for scripting, where a prompt is useless; a human types this.
 *
 * WHY IT RE-RUNS. Changing anything is the same command again, prefilled with
 * what is already configured — pressing Enter through it is a no-op. That is
 * cheaper to remember than a set of edit verbs, and it means the wizard is also
 * the way to read back what the current setup is.
 *
 * WHAT IT DOES NOT DO. It never writes a credential into the config. An API key
 * is recorded as `apiKeyEnv` — the NAME of an environment variable — because a
 * config file is a backup/dotfile/git footgun, and the daemon already warns
 * about inline keys at startup. The probe deliberately verifies whatever will be
 * persisted (see `resolveSubmittedApiKey`), so a green check never means "the
 * key you typed works" while storing a reference that does not.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';
import { CLIENT_IDS } from '@zhixuan92/multi-model-agent-core';
import {
  applyToConfig,
  type AgentsCarrier,
  persistConfig,
  probeApi,
  type ConfigureProviderRequest,
} from '../http/handlers/introspection/configure-provider.js';
import { persistDeclaredState, readDeclaredState } from './declared-roster.js';
import { detectCliClients } from '../provisioning/cli-provisioning.js';
import { runSyncSkills } from './sync-skills.js';
import type { DeclaredClientRoster } from '../provisioning/roster.js';

/** Tiers in the order they are asked. `main` first because it is the one a user
 *  has an opinion about — it is the orchestrator brain — and answering it makes
 *  the other two easier to reason about. All three are required: `main` is both
 *  the `orchestrate` tier and the cost baseline every run is priced against. */
const TIERS = [
  { key: 'main' as const, label: 'main', blurb: 'your own model — drives mma, runs orchestrate' },
  { key: 'complex' as const, label: 'complex', blurb: 'smart workers' },
  { key: 'standard' as const, label: 'standard', blurb: 'cheap workers' },
];

export interface SetupDeps {
  homeDir?: string;
  configPath?: string;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  /** Ask a free-text question, returning the trimmed answer (empty = accept the
   *  shown default). Injected so the whole flow is testable without a TTY. */
  ask?: (question: string, fallback?: string) => Promise<string>;
  /** Yes/no. `fallback` is what an empty answer means. */
  confirm?: (question: string, fallback: boolean) => Promise<boolean>;
  /** Test seam: skip the live provider probe. */
  skipProbe?: boolean;
  detected?: ReadonlySet<ClientId>;
  skillsRoot?: string;
}

export const SetupExitCode = { SUCCESS: 0, ERR_ABORTED: 1, ERR_PARTIAL: 2 } as const;

function defaultConfigPath(homeDir: string): string {
  return join(homeDir, '.mma', 'config.json');
}

/** Whatever is already configured, so every question can be prefilled. Never
 *  throws: an unreadable config means "nothing to prefill", not a failure. */
function readExistingAgents(configPath: string): Record<string, { type?: string; model?: string; apiKeyEnv?: string; baseUrl?: string }> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const agents = (parsed as { agents?: unknown }).agents;
    if (typeof agents !== 'object' || agents === null) return {};
    return agents as Record<string, { type?: string; model?: string; apiKeyEnv?: string; baseUrl?: string }>;
  } catch {
    return {};
  }
}

export async function runSetup(deps: SetupDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const out = (s: string): void => { stdout(s); };
  const homeDir = deps.homeDir ?? homedir();
  const configPath = deps.configPath ?? defaultConfigPath(homeDir);

  if (!deps.ask || !deps.confirm) {
    stderr('mma setup needs an interactive terminal. For scripts use `mma enable --target=<ClientId>` and edit the config directly.\n');
    return SetupExitCode.ERR_ABORTED;
  }
  const ask = deps.ask;
  const confirm = deps.confirm;

  const existing = readExistingAgents(configPath);
  const reconfiguring = Object.keys(existing).length > 0;
  out(`\nMMA setup — writes ${configPath}\n`);
  out(reconfiguring
    ? 'Prefilled with your current settings; press Enter to keep any of them.\n\n'
    : 'Press Enter at any prompt to accept the suggested value.\n\n');

  // ── Agents ────────────────────────────────────────────────────────────────
  // Typed as the carrier the two config functions declare, so `mma setup` and the HTTP
  // configure-provider handler hand them the SAME shape. Spelling it structurally here and casting
  // at each call is what produced the two `as never` arguments this replaced.
  const config: AgentsCarrier = { agents: { ...existing } };
  out('Step 1 of 2 · Agents\n');

  for (const tier of TIERS) {
    const current = existing[tier.key];
    out(`  ${tier.label} (${tier.blurb})\n`);

    const provider = (await ask('    provider — claude or codex', current?.type ?? 'claude')).toLowerCase();
    if (provider !== 'claude' && provider !== 'codex') {
      stderr(`    '${provider}' is not a provider type; expected claude or codex.\n`);
      return SetupExitCode.ERR_ABORTED;
    }

    // `claude` = the Anthropic wire protocol, `codex` = the OpenAI one — the
    // type is the PROTOCOL, not the vendor, so an OAuth subscription and a
    // third-party compatible endpoint are both legitimate answers here.
    const subscription = provider === 'claude' ? 'Claude subscription (OAuth)' : 'ChatGPT subscription (OAuth)';
    const useOauth = await confirm(`    auth — ${subscription}? (no = API key)`, current?.apiKeyEnv === undefined);

    let auth: ConfigureProviderRequest['auth'];
    if (useOauth) {
      auth = { mode: 'oauth' };
    } else {
      const envVar = await ask(
        '    env var holding the API key (the NAME, not the key)',
        current?.apiKeyEnv ?? (provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'),
      );
      const baseUrl = await ask('    base URL (blank for the provider default)', current?.baseUrl ?? '');
      auth = { mode: 'api-key', apiKeyEnv: envVar, ...(baseUrl ? { baseUrl } : {}) };
      if (!process.env[envVar]) {
        out(`    note: ${envVar} is not set in this shell — set it before \`mma serve\`.\n`);
      }
    }

    const model = await ask('    model id', current?.model ?? '');
    if (!model) {
      stderr('    a model id is required.\n');
      return SetupExitCode.ERR_ABORTED;
    }

    const request = { tier: tier.key, provider, model, auth, dryRun: false } as ConfigureProviderRequest;
    if (!deps.skipProbe) {
      const probe = await probeApi(request);
      out(probe.reachable
        ? `    ✓ ${probe.detail}\n`
        : `    ! ${probe.detail} — saved anyway; fix the credential and re-run \`mma setup\`.\n`);
    }
    applyToConfig(config, request);
  }

  const written = persistConfig(configPath, config);
  if (!written.ok) {
    stderr(`mma setup: could not write ${configPath}: ${written.error}\n`);
    return SetupExitCode.ERR_PARTIAL;
  }
  out(`\n  wrote agents to ${configPath}\n`);

  // ── Clients ───────────────────────────────────────────────────────────────
  out('\nStep 2 of 2 · Clients\n');
  const detected = deps.detected ?? detectCliClients(homeDir);
  const declared: DeclaredClientRoster = readDeclaredState(configPath) ?? {};
  // Offer what is detected plus anything already declared, so a client the user
  // turned on previously is never silently dropped just because its directory
  // moved.
  const candidates = CLIENT_IDS.filter((id) => detected.has(id) || declared[id] !== undefined);

  if (candidates.length === 0) {
    out('  no supported clients detected — run `mma setup` again after installing one.\n');
  } else {
    const on: ClientId[] = [];
    const off: ClientId[] = [];
    for (const id of candidates) {
      const wasOn = declared[id] === 'on';
      const want = await confirm(`  provision ${id}?`, wasOn || declared[id] === undefined);
      (want ? on : off).push(id);
    }
    if (on.length > 0) persistDeclaredState(configPath, on, 'on');
    if (off.length > 0) persistDeclaredState(configPath, off, 'off');

    if (on.length > 0) {
      const code = await runSyncSkills({
        homeDir,
        declared: readDeclaredState(configPath),
        stdout: deps.stdout ?? (() => true),
        stderr: deps.stderr ?? (() => true),
        ...(deps.skillsRoot !== undefined && { skillsRoot: deps.skillsRoot }),
      });
      if (code !== 0) {
        stderr('mma setup: some clients could not be provisioned — see above.\n');
        return SetupExitCode.ERR_PARTIAL;
      }
    }
    out(`  on: ${on.join(', ') || '(none)'}${off.length ? `   off: ${off.join(', ')}` : ''}\n`);
  }

  out('\nDone. Start the daemon with `mma serve`.\n');
  out('Upgrades need nothing but `npm i -g @zhixuan92/multi-model-agent` — skills refresh themselves.\n');
  out('Re-run `mma setup` any time to change any of this; it comes back prefilled.\n\n');
  return SetupExitCode.SUCCESS;
}

/** Real readline prompts. Kept out of `runSetup` so every question above is
 *  driven by an injected function in tests. */
export function ttyPrompts(): Pick<SetupDeps, 'ask' | 'confirm'> {
  const readline = (question: string): Promise<string> => import('node:readline/promises').then(async (rl) => {
    const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await iface.question(question)).trim();
    } finally {
      iface.close();
    }
  });
  return {
    ask: async (question, fallback) => {
      const shown = fallback ? `${question} [${fallback}]: ` : `${question}: `;
      const answer = await readline(shown);
      return answer || fallback || '';
    },
    confirm: async (question, fallback) => {
      const answer = (await readline(`${question} [${fallback ? 'Y/n' : 'y/N'}] `)).toLowerCase();
      if (!answer) return fallback;
      return answer.startsWith('y');
    },
  };
}

/** Whether an interactive setup is even possible. A piped or CI invocation gets
 *  a clear refusal rather than hanging on a prompt nobody can answer. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
