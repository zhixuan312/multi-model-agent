import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as notify from '../../packages/server/src/install/notify.js';
import * as headers from '../../packages/server/src/install/headers.js';
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

describe('notifySkillInstalled', () => {
  it('is a no-op function', () => {
    expect(() => notify.notifySkillInstalled('mma-delegate', 'claude-code')).not.toThrow();
    expect(notify.notifySkillInstalled('mma-delegate', 'claude-code')).toBeUndefined();
  });

  it('calls clientHeaders with the mapped client name for gemini', () => {
    const spy = vi.spyOn(headers, 'clientHeaders');
    notify.notifySkillInstalled('mma-delegate', 'gemini');
    expect(spy).toHaveBeenCalledWith('gemini-cli');
    spy.mockRestore();
  });

  it('calls clientHeaders with the mapped client name for codex', () => {
    const spy = vi.spyOn(headers, 'clientHeaders');
    notify.notifySkillInstalled('mma-delegate', 'codex');
    expect(spy).toHaveBeenCalledWith('codex-cli');
    spy.mockRestore();
  });

  it('calls clientHeaders with the mapped client name for cursor', () => {
    const spy = vi.spyOn(headers, 'clientHeaders');
    notify.notifySkillInstalled('mma-delegate', 'cursor');
    expect(spy).toHaveBeenCalledWith('cursor');
    spy.mockRestore();
  });

  it('calls clientHeaders with the mapped client name for claude-code', () => {
    const spy = vi.spyOn(headers, 'clientHeaders');
    notify.notifySkillInstalled('mma-delegate', 'claude-code');
    expect(spy).toHaveBeenCalledWith('claude-code');
    spy.mockRestore();
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
    expect(spy).toHaveBeenCalledWith('mma-test-skill', 'claude-code');
  });

  it('fires for gemini', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'gemini', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version);
    expect(spy).toHaveBeenCalledWith('mma-test-skill', 'gemini');
  });

  it('fires for codex', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'codex', baseOpts.homeDir, baseOpts.skillsRoot);
    expect(spy).toHaveBeenCalledWith('mma-test-skill', 'codex');
  });

  it('fires for cursor', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'cursor', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version, baseOpts.cwd);
    expect(spy).toHaveBeenCalledWith('mma-test-skill', 'cursor');
  });
});
