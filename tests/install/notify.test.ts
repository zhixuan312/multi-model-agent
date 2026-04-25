import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as notify from '../../packages/server/src/install/notify.js';
import { writeSkillToClient } from '../../packages/server/src/install/manifest-resolve.js';
import { setRecorderForTest } from '../../packages/server/src/telemetry/recorder.js';
import type { Recorder } from '../../packages/server/src/telemetry/recorder.js';

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

function mockRecorder(): Recorder {
  return {
    recordTaskCompleted: vi.fn(),
    recordSessionStarted: vi.fn(),
    recordInstallChanged: vi.fn(),
    recordSkillInstalled: vi.fn(),
  };
}

describe('notifySkillInstalled', () => {
  it('forwards to recorder.recordSkillInstalled', () => {
    const rec = mockRecorder();
    setRecorderForTest(rec);
    notify.notifySkillInstalled('mma-delegate', 'claude-code');
    expect(rec.recordSkillInstalled).toHaveBeenCalledWith('mma-delegate', 'claude-code');
  });
});

describe('notifySkillInstalled errors are silent', () => {
  it('does not throw when recorder throws', () => {
    const boom: Recorder = {
      recordTaskCompleted: vi.fn(),
      recordSessionStarted: vi.fn(),
      recordInstallChanged: vi.fn(),
      recordSkillInstalled: () => { throw new Error('boom'); },
    };
    setRecorderForTest(boom);
    expect(() => notify.notifySkillInstalled('mma-delegate', 'claude-code')).not.toThrow();
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
