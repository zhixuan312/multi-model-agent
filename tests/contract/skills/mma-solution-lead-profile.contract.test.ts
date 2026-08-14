import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { INITIATIVE_OPERATIONS, initiativeMutationRequestSchema } from '../../../packages/core/src/initiative-record/index.js';
import { runMcpInstallCommand } from '../../../packages/server/src/cli/clients.js';
import { SUPPORTED_SKILLS } from '../../../packages/server/src/skill-install/discover.js';
import { listEntries } from '../../../packages/server/src/skill-install/manifest.js';

const skillPath = resolve('packages/server/src/skills/mma-solution-lead/SKILL.md');

describe('mma-solution-lead packaged profile', () => {
  it('matches real operations, contains all never-do rules, and is provisioned and recorded', async () => {
    const content = readFileSync(skillPath, 'utf8');
    const parsed = matter(content);
    expect(SUPPORTED_SKILLS).toContain('mma-solution-lead');
    expect(parsed.data.name).toBe('mma-solution-lead');
    expect(parsed.data.description).toEqual(expect.any(String));
    expect(parsed.data.when_to_use).toEqual(expect.any(String));
    expect(parsed.data.description.length).toBeGreaterThan(20);
    expect(parsed.data.when_to_use.length).toBeGreaterThan(20);
    expect(parsed.data.version).toMatch(/^(\d+\.\d+\.\d+|0\.0\.0-unreleased)$/);
    const references = parsed.data.operation_references;
    expect(references).toEqual(expect.arrayContaining(['initiative_bootstrap']));
    expect(references.every((operation: string) => (INITIATIVE_OPERATIONS as readonly string[]).includes(operation))).toBe(true);
    const neverDo = content.match(/^## Never do\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
    expect(neverDo).toMatch(/never-do-1[\s\S]*(Product ID|uuid|revision|Task state|link role|provider routing|Git)/i);
    expect(neverDo).toMatch(/never-do-2[\s\S]*Verification Run/i);
    expect(neverDo).toMatch(/never-do-3[\s\S]*unconfirmed draft/i);
    // The documented `initiative_bootstrap` example must stay a genuinely valid request — extract
    // it straight from the shipped SKILL.md and parse it against the real mutation schema, so a
    // future edit that breaks the example (missing mutation controls, an unsupported status/outcome
    // pairing, etc.) fails the build instead of shipping a call that always fails validation.
    const exampleJson = content.match(/```json\n(\{[\s\S]*?"operation":\s*"initiative_bootstrap"[\s\S]*?\n\})\n```/)?.[1];
    expect(exampleJson, 'no initiative_bootstrap example JSON block found in SKILL.md').toBeTruthy();
    const example = JSON.parse(exampleJson!);
    const exampleValidation = initiativeMutationRequestSchema.safeParse(example);
    const issues = exampleValidation.success ? [] : exampleValidation.error.issues;
    expect(exampleValidation.success, `documented initiative_bootstrap example fails schema validation: ${JSON.stringify(issues)}`).toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'mma-solution-lead-'));
    try {
      await runMcpInstallCommand({ clientId: 'cursor', config: { server: { stateDir: join(home, '.mma', 'state') } }, homeDir: home });
      expect(existsSync(join(home, '.agents', 'skills', 'mma-solution-lead', 'SKILL.md'))).toBe(true);
      expect(listEntries(home)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mma-solution-lead', targets: expect.arrayContaining(['cursor']) })]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});