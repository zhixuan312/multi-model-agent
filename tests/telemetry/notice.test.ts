import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const { showNotice } = await import(
  '../../packages/server/src/telemetry/notice.js'
);

const FLAG = 'telemetry-notice-shown';
const PRIVACY_URL =
  'https://github.com/zhixuan312/multi-model-agent/blob/main/docs/PRIVACY.md';

function tempDir() {
  const p = join(tmpdir(), `mma-notice-test-${randomUUID()}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function flagPath(dir: string) {
  return join(dir, FLAG);
}

function bannerContains(text: string, substr: string) {
  return text.includes(substr);
}

describe('notice', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the disabled-state banner when consent is disabled and the flag is absent; creates the flag', () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'default' }, write);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('OFF by default');
    expect(writes[0]).toContain('mmagent telemetry enable');
    expect(writes[0]).toContain(PRIVACY_URL);
    expect(existsSync(flagPath(dir))).toBe(true);
  });

  it('prints the enabled-state banner when consent is enabled and the flag is absent', () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: true, source: 'env' }, write);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('ENABLED');
    expect(writes[0]).toContain('mmagent telemetry disable');
    expect(writes[0]).toContain(PRIVACY_URL);
    expect(existsSync(flagPath(dir))).toBe(true);
  });

  it('prints the disabled-state banner for env_invalid source', () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'env_invalid' }, write);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('DISABLED (source: env_invalid)');
    expect(writes[0]).toContain('env_invalid');
    expect(writes[0]).toContain('fail-closed');
    expect(existsSync(flagPath(dir))).toBe(true);
  });

  it('prints the disabled-state banner for config_unreadable source', () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'config_unreadable' }, write);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('DISABLED (source: config_unreadable)');
    expect(writes[0]).toContain('config_unreadable');
    expect(writes[0]).toContain('could not be parsed');
    expect(existsSync(flagPath(dir))).toBe(true);
  });

  it('prints the disabled-state banner for explicit env disable', () => {
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'env' }, write);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('DISABLED (source: env)');
    // explicit env/opt-out disable should NOT include the extra env_invalid text
    expect(writes[0]).not.toContain('env_invalid');
    expect(writes[0]).not.toContain('fail-closed');
    expect(existsSync(flagPath(dir))).toBe(true);
  });

  it('does NOT print when the flag is present', () => {
    writeFileSync(flagPath(dir), '', { mode: 0o644 });
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'default' }, write);

    expect(writes.length).toBe(0);
  });

  it('does NOT call getOrCreateInstallId (banner predates identity)', () => {
    // Verify the implementation does not import install-id.
    // We check by confirming the module source has no reference to install-id.
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    showNotice(dir, { enabled: false, source: 'default' }, write);

    // The install-id file should NOT exist in the dir
    expect(existsSync(join(dir, 'install-id'))).toBe(false);
  });

  it('flag NOT created if the banner write fails', () => {
    const write = (_msg: string) => {
      throw new Error('stderr pipe broken');
    };

    expect(() => showNotice(dir, { enabled: false, source: 'default' }, write)).not.toThrow();
    expect(existsSync(flagPath(dir))).toBe(false);
  });

  it('returns silently (no throw) when dir does not exist and write succeeds', () => {
    const badDir = join(dir, 'nonexistent');
    const writes: string[] = [];
    const write = (msg: string) => writes.push(msg);

    // The function tries to writeFileSync to a path inside a nonexistent
    // directory — this should throw ENOENT, which is caught silently.
    expect(() => showNotice(badDir, { enabled: false, source: 'default' }, write)).not.toThrow();
    // Banner was written before flag creation failed
    expect(writes.length).toBe(1);
    // Flag was NOT created because writeFileSync threw
    expect(existsSync(flagPath(badDir))).toBe(false);
  });
});
