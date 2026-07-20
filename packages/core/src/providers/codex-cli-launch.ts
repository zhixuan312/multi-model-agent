// Pure flag-construction for spawning the `codex` CLI. No I/O. Tested in
// isolation; CodexCliSession composes this with subprocess management.
//
// One shape produced for every codex invocation. Backend selection
// (subscription / openai-api / openai-compatible) is encoded entirely in
// the `-c model_providers.X={...}` overrides — never via global config.

import type { SessionOpts } from '../types/run-result.js';

export interface CodexCliConfig {
  /** Required. Model id passed to `-m`. */
  model: string;
  /** Optional. When set, registers a custom model_provider with this base_url. */
  baseUrl?: string;
  /** Optional. Env-var name read by codex for the API key when baseUrl is set. */
  apiKeyEnv?: string;
  /** Optional. Static API key — injected into env under apiKeyEnv at spawn time. */
  apiKey?: string;
}

export interface BuildLaunchInput {
  cfg: CodexCliConfig;
  opts: Pick<SessionOpts, 'cwd' | 'sandboxPolicy'>;
  outputFile: string;
  schemaFile?: string;
  /** When set, the launch is a `codex exec resume <id>` (subsequent turn). */
  resumeSessionId?: string;
  /** When set, becomes the subprocess `CODEX_HOME` (ephemeral skills home). */
  codexHome?: string;
}

export interface CodexCliLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const CUSTOM_PROVIDER_NAME = 'mma-custom';

export function buildCodexCliLaunch(input: BuildLaunchInput): CodexCliLaunch {
  const { cfg, opts, outputFile, schemaFile, resumeSessionId, codexHome } = input;

  // `--ask-for-approval never` is a global flag (must precede `exec`) that
  // suppresses all approval prompts for non-interactive runs — it works with
  // every `--sandbox` mode. Together with `--sandbox <mode>` below it replaces
  // the old `--dangerously-bypass-approvals-and-sandbox`, which disabled the OS
  // sandbox ENTIRELY: that left read-only / cwd-only task types with no write
  // confinement on the codex runner (a cross-runner security gap — Claude
  // enforces the same policy via its PreToolUse hook).
  const args: string[] = ['--ask-for-approval', 'never', 'exec'];
  if (resumeSessionId) args.push('resume', resumeSessionId);

  args.push(
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
  );

  // Working directory + sandbox apply only on the initial turn. `resume`
  // inherits cwd + sandbox from the stored session record. The sandbox mode
  // mirrors the task type's policy: `read-only` blocks all writes; `cwd-only`
  // maps to `workspace-write` (writes confined to the cwd + temp dirs).
  if (!resumeSessionId) {
    const sandboxMode = opts.sandboxPolicy === 'read-only' ? 'read-only' : 'workspace-write';
    args.push('-C', opts.cwd ?? process.cwd(), '-s', sandboxMode);
  }

  args.push('-m', cfg.model);

  if (schemaFile) args.push('--output-schema', schemaFile);
  args.push('-o', outputFile);

  // Custom OpenAI-compatible backend
  if (cfg.baseUrl) {
    const envKey = cfg.apiKeyEnv ?? 'OPENAI_API_KEY';
    const providerInline = [
      `name="${CUSTOM_PROVIDER_NAME}"`,
      `base_url="${cfg.baseUrl}"`,
      `env_key="${envKey}"`,
      `wire_api="responses"`,
    ].join(',');
    args.push(
      '-c', `model_providers.${CUSTOM_PROVIDER_NAME}={${providerInline}}`,
      '-c', `model_provider="${CUSTOM_PROVIDER_NAME}"`,
    );
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (cfg.apiKey) env[cfg.apiKeyEnv ?? 'OPENAI_API_KEY'] = cfg.apiKey;
  if (codexHome) env.CODEX_HOME = codexHome;

  return {
    command: process.env.MMA_CODEX_BIN ?? 'codex',
    args,
    env,
  };
}
