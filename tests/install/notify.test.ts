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
  // statSync → ENOENT (file doesn't exist)
  vi.mocked(fs.statSync).mockImplementation(() => {
    throw enoent;
  });
  // existsSync → true for dirs we need, false otherwise
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    // codex writer checks for AGENTS.md path as a directory (.codex dir)
    return s.endsWith('.codex');
  });
  // mkdirSync, writeFileSync — no-ops
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  // readFileSync — throw ENOENT by default, codex handles it
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw enoent;
  });
}

describe('notifySkillInstalled', () => {
  it('is a no-op function', () => {
    expect(() => notify.notifySkillInstalled('mma-delegate', 'claude-code')).not.toThrow();
    expect(notify.notifySkillInstalled('any-skill', 'any-client')).toBeUndefined();
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
