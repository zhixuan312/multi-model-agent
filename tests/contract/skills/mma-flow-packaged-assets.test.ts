import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS, readCommandContent } from '../../../packages/server/src/skill-install/discover.js';

const root = path.resolve('packages/server/src/skills/mma-flow');

describe('contract: mma-flow packaged assets', () => {
  it('mma-flow is in SUPPORTED_COMMANDS (not SUPPORTED_SKILLS)', () => {
    expect(SUPPORTED_COMMANDS).toContain('mma-flow');
    expect(SUPPORTED_SKILLS).not.toContain('mma-flow');
  });

  it('ships the SKILL.md with no superpowers references', () => {
    const skillMd = path.join(root, 'SKILL.md');
    expect(existsSync(skillMd), skillMd).toBe(true);
    expect(readFileSync(skillMd, 'utf8')).not.toContain('superpowers:');
  });

  it('does not ship any workflow scripts', () => {
    expect(existsSync(path.join(root, 'workflows'))).toBe(false);
  });

  it('readCommandContent reads mma-flow SKILL.md from the skills root', () => {
    const content = readCommandContent('mma-flow');
    expect(content).toBeTruthy();
    expect(content).toContain('name: mma-flow');
    expect(content).toContain('Claude Code command');
  });

  it('readCommandContent returns null for nonexistent commands', () => {
    expect(readCommandContent('mma-nonexistent')).toBeNull();
  });
});
