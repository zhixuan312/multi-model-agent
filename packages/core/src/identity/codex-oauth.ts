import fs from 'fs';
import path from 'path';
import os from 'os';

const CODEX_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

// Track which paths we have already warned about so getCodexAuth() can be
// called repeatedly (it is, on every sub-agent dispatch) without spamming
// stderr with the same chmod warning.
const warnedPaths = new Set<string>();

function warnIfWorldReadable(authPath: string): void {
  // Permission bits are POSIX-only. On Windows, mode bits are not meaningful.
  if (process.platform === 'win32') return;
  if (warnedPaths.has(authPath)) return;
  try {
    const stats = fs.statSync(authPath);
    const groupOrOtherReadable = (stats.mode & 0o077) !== 0;
    if (groupOrOtherReadable) {
      warnedPaths.add(authPath);
      const mode = (stats.mode & 0o777).toString(8);
      // eslint-disable-next-line no-console
      console.warn(
        `[multi-model-agent] WARNING: ${authPath} has permissions 0${mode} ` +
          `and is readable by other users on this system. Run \`chmod 600 ${authPath}\` ` +
          `to restrict access to your Codex OAuth token.`,
      );
    }
  } catch {
    // statSync should not normally fail here (we just confirmed existsSync),
    // but if it does there's nothing useful to warn about.
  }
}

export function getCodexAuth(): CodexAuth | null {
  const authPath = CODEX_AUTH_PATH();
  if (!fs.existsSync(authPath)) return null;

  warnIfWorldReadable(authPath);

  try {
    const raw: CodexAuthFile = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (!raw.tokens?.access_token || !raw.tokens?.account_id) return null;
    return {
      accessToken: raw.tokens.access_token,
      accountId: raw.tokens.account_id,
    };
  } catch {
    return null;
  }
}
