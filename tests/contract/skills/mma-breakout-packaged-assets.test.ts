import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('packages/server/src/skills/mma-breakout');

describe('contract: mma-breakout packaged assets', () => {
  it('ships a Claude Code command SKILL.md with no superpowers references', () => {
    const skillMd = path.join(root, 'SKILL.md');
    expect(existsSync(skillMd), skillMd).toBe(true);

    const content = readFileSync(skillMd, 'utf8');
    expect(content).toContain('name: mma-breakout');
    expect(content).toContain('version: "0.0.0-unreleased"');
    expect(content).toContain('# /mma-breakout');
    expect(content).toContain('Claude Code command');
    expect(content).not.toContain('superpowers:');
  });

  it('does not ship any workflow scripts', () => {
    expect(existsSync(path.join(root, 'workflows'))).toBe(false);
  });

  it('documents the breakout lifecycle, journaling gate, and forbidden backend behaviors', () => {
    const skill = readFileSync(path.join(root, 'SKILL.md'), 'utf8');

    expect(skill).toContain('role');
    expect(skill).toContain('topic');
    expect(skill).toContain('sonnet');
    expect(skill).toContain('read-only repository access');
    expect(skill).toContain('run_in_background: true');
    expect(skill).toContain('@name');
    expect(skill).toContain('contentless idle pings');
    expect(skill).toContain('learning');
    expect(skill).toContain('decision');
    expect(skill).toContain('design');
    expect(skill).toContain('behavior');
    expect(skill).toContain('process');
    expect(skill).toContain('knowledge');
    expect(skill).toContain('style');
    expect(skill).toContain('exactly one `journal_record` task');
    expect(skill).toContain('TaskStop');
    expect(skill).toContain("raw `.output` transcript");
    expect(skill).toContain('No server schema, task type, or HTTP route is added');
    expect(skill).toContain('client-side only');
    expect(skill).toContain('not an auto-matched skill');
    expect(skill).toContain('main-agent desync');
    expect(skill).toContain('genuine context corruption');
  });
});
