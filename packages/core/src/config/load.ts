import fs from 'fs';
import { multiModelConfigSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

/**
 * Load the auth token for the HTTP server.
 * If `MMAGENT_AUTH_TOKEN` is set in the environment, it wins over any file.
 * Otherwise reads and returns the file at `opts.tokenFile`.
 */
export function loadAuthToken(opts: { tokenFile: string }): string {
  const envToken = process.env['MMAGENT_AUTH_TOKEN'];
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  return fs.readFileSync(opts.tokenFile, 'utf-8').trim();
}

/**
 * Warn if any openai-compatible agent in the parsed config carries an
 * inline `apiKey` instead of using `apiKeyEnv`. The schema permits both,
 * but storing a plaintext API key in a config file that may end up in a
 * backup, dotfile repo, or git is a footgun. We surface the issue at load
 * time, once, so the operator notices.
 */
function warnOnInlineApiKey(config: MultiModelConfig, configPath: string): void {
  const offenders: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (
      agent.type === 'openai-compatible' &&
      typeof (agent as { apiKey?: unknown }).apiKey === 'string'
    ) {
      offenders.push(name);
    }
  }
  if (offenders.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[multi-model-agent] WARNING: ${configPath} stores an inline \`apiKey\` for ` +
        `agent(s): ${offenders.join(', ')}. Prefer \`apiKeyEnv\` and read the key ` +
        `from an environment variable so it never lands in version control.`,
    );
  }
}

/**
 * Load and parse a config file by path.
 * No auto-lookup — callers must provide the path.
 * Core has no knowledge of MULTI_MODEL_CONFIG env var or home-directory discovery.
 */
export async function loadConfigFromFile(path: string): Promise<MultiModelConfig> {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(new Error(`Config file not found: ${path}`));
        return;
      }
      try {
        const raw = JSON.parse(data);
        const parsed = multiModelConfigSchema.parse(raw);
        warnOnInlineApiKey(parsed, path);
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}
