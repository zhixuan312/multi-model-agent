import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
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
    return String(p).endsWith('.codex');
  });
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
  vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw enoent;
  });
}

describe('install writers emit correct X-MMA-Client header', () => {
  let clientHeadersSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFsForNonExistentFiles();
    clientHeadersSpy = vi.spyOn(headers, 'clientHeaders');
  });

  afterEach(() => {
    clientHeadersSpy.mockRestore();
  });

  it('claude-code writer emits X-MMA-Client: claude-code', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'claude-code', baseOpts.homeDir, baseOpts.skillsRoot);
    expect(clientHeadersSpy).toHaveBeenCalledWith('claude-code');
    expect(clientHeadersSpy).toHaveReturnedWith({ 'X-MMA-Client': 'claude-code' });
  });

  it('cursor writer emits X-MMA-Client: cursor', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'cursor', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version, baseOpts.cwd);
    expect(clientHeadersSpy).toHaveBeenCalledWith('cursor');
    expect(clientHeadersSpy).toHaveReturnedWith({ 'X-MMA-Client': 'cursor' });
  });

  it('codex writer emits X-MMA-Client: codex-cli', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'codex', baseOpts.homeDir, baseOpts.skillsRoot);
    expect(clientHeadersSpy).toHaveBeenCalledWith('codex-cli');
    expect(clientHeadersSpy).toHaveReturnedWith({ 'X-MMA-Client': 'codex-cli' });
  });

  it('gemini writer emits X-MMA-Client: gemini-cli', () => {
    writeSkillToClient(baseOpts.skillName, baseOpts.content, 'gemini', baseOpts.homeDir, baseOpts.skillsRoot, baseOpts.version);
    expect(clientHeadersSpy).toHaveBeenCalledWith('gemini-cli');
    expect(clientHeadersSpy).toHaveReturnedWith({ 'X-MMA-Client': 'gemini-cli' });
  });
});
