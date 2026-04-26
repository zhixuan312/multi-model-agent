import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as edSign,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Identity {
  installId: string;
  generatedAt: string;
  privateKeyPkcs8: string;
  publicKeyRaw: string;
}

export function getOrCreateIdentity(homeDir: string): Identity {
  const path = join(homeDir, 'identity.json');
  try {
    const id = JSON.parse(readFileSync(path, 'utf8')) as Identity;
    const ageMs = Date.now() - new Date(id.generatedAt).getTime();
    if (ageMs < 365 * 24 * 3600 * 1000) {
      return id;
    }
    // Older than 365 days → falls through to regeneration block below.
  } catch {
    // missing or corrupt → regenerate
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id: Identity = {
    installId: randomUUID(),
    generatedAt: new Date().toISOString(),
    privateKeyPkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeyRaw: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  writeFileSync(path, JSON.stringify(id), { mode: 0o600 });
  return id;
}

export function sign(privateKeyPkcs8Base64: string, jsonBody: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return edSign(null, Buffer.from(jsonBody, 'utf8'), key).toString('base64');
}
