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

export function getCodexAuth(): CodexAuth | null {
  const authPath = CODEX_AUTH_PATH();
  if (!fs.existsSync(authPath)) return null;

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
