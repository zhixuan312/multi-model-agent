import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as notify from '../../packages/server/src/install/notify.js';
import { writeSkillToClient } from '../../packages/server/src/install/manifest-resolve.js';

vi.mock('node:fs');

const baseOpts = {
  skillName: 'mma-test-skill',
  content: '# Test Skill\n\nThis is a test skill.',
  homeDir: '/tmp/mma-test-home',
  skillsRoot: '/tmp/mma-test-skills',
  version: '1.0.0',
  cwd: '/tmp/mma-test-cwd',
};

const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' as const });

function mockFsForNonExistentFiles() {
  vi.mocked(fs.statSync).mockImplementation(() => {
    throw enoent;
  });
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    return s.endsWith('.codex');
  });
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw enoent;
  });
}

describe('notifySkillInstalled (no-op without fetch)', () => {
  it('is a no-op when fetch is not provided', () => {
    expect(() => notify.notifySkillInstalled({ skillId: 'mma-delegate', client: 'claude-code' })).not.toThrow();
    expect(notify.notifySkillInstalled({ skillId: 'mma-delegate', client: 'claude-code' })).toBeUndefined();
  });
});

describe('notifySkillInstalled (with fetch)', () => {
  it('POSTs with X-MMA-Client: claude-code for claude-code client', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    };
    notify.notifySkillInstalled({ skillId: 'mma-delegate', client: 'claude-code', fetch: fakeFetch as typeof globalThis.fetch });
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedHeaders).toBeTruthy();
    expect(capturedHeaders!['X-MMA-Client']).toBe('claude-code');
  });

  it('POSTs with X-MMA-Client: gemini-cli for gemini client', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    };
    notify.notifySkillInstalled({ skillId: 'mma-delegate', client: 'gemini', fetch: fakeFetch as typeof globalThis.fetch });
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedHeaders).toBeTruthy();
    expect(capturedHeaders!['X-MMA-Client']).toBe('gemini-cli');
  });
});

describe('writeSkillToClient calls notifySkillInstalled after successful install', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFsForNonExistentFiles();
    spy = vi.spyOn(notify, 'notifySkillInstalled');
  });

  it('fires for claude-code', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'claude-code', baseOpts.homeDir, baseOpts.skillsRoot);
    expect(spy).toHaveBeenCalledWith({ skillId: 'mma-test-skill', client: 'claude-code' });
  });

  it('fires for gemini', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'gemini', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version);
    expect(spy).toHaveBeenCalledWith({ skillId: 'mma-test-skill', client: 'gemini' });
  });

  it('fires for codex', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'codex', baseOpts.homeDir, baseOpts.skillsRoot);
    expect(spy).toHaveBeenCalledWith({ skillId: 'mma-test-skill', client: 'codex' });
  });

  it('fires for cursor', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'cursor', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version, baseOpts.cwd);
    expect(spy).toHaveBeenCalledWith({ skillId: 'mma-test-skill', client: 'cursor' });
  });
});
