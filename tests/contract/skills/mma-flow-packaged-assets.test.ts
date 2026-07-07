import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_SKILLS, SUPPORTED_COMMANDS, readCommandContent } from '../../../packages/server/src/skill-install/discover.js';

const root = path.resolve('packages/server/src/skills/mma-flow');
const files = [
  path.join(root, 'SKILL.md'),
  path.join(root, 'workflows', 'segment-spec-audit.js'),
  path.join(root, 'workflows', 'segment-plan-audit.js'),
  path.join(root, 'workflows', 'segment-review.js'),
  path.join(root, 'workflows', 'segment-execute.js'),
];

describe('contract: mma-flow packaged assets', () => {
  it('mma-flow is in SUPPORTED_COMMANDS (not SUPPORTED_SKILLS)', () => {
    expect(SUPPORTED_COMMANDS).toContain('mma-flow');
    expect(SUPPORTED_SKILLS).not.toContain('mma-flow');
  });

  it('ships the expected packaged files with no superpowers references', () => {
    for (const filePath of files) {
      expect(existsSync(filePath), filePath).toBe(true);
      expect(readFileSync(filePath, 'utf8')).not.toContain('superpowers:');
    }
  });

  it('loads each workflow file as valid ESM JavaScript', async () => {
    for (const filePath of files.slice(1)) {
      const mod = await import(pathToFileURL(filePath).href);
      expect(mod).toBeTruthy();
    }
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
