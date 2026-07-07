import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const skillPath = path.resolve('packages/server/src/skills/mma-flow/SKILL.md');
const specSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-spec-audit.js');
const planSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-plan-audit.js');

describe('mma-flow audit playbook assets', () => {
  it('publishes the playbook frontmatter and stage order without superpowers references', async () => {
    const raw = readFileSync(skillPath, 'utf8');
    const { data, content } = matter(raw);

    expect(data.name).toBe('mma-flow');
    expect(String(data.description)).toMatch(/^Use when\b/);
    expect(data.version).toBe('0.0.0-unreleased');
    expect(content).toContain('Stage 0 LOCATE');
    expect(content).toContain('1. `D1` — run `mma-design`');
    expect(content).toContain('2. `D2` — run `mma-spec`');
    for (const stage of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']) {
      expect(content).toContain(stage);
    }
    expect(content).toContain('docs/mma/specs/');
    expect(content).toContain('docs/mma/plans/');
    expect(content).toContain('mma/<slug>');
    expect(content).toContain('gh pr create --base');
    expect(content).toContain('Deferred-Decision Ledger');
    expect(raw).not.toContain('superpowers:');
  });

  it('runs the spec audit loop with early exit on a clean first round', async () => {
    const { runSegmentSpecAudit } = await import(specSegmentPath);
    const calls: string[] = [];
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        calls.push(request.skill);
        return {
          findingsSummary: 'clean',
          findings: [],
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          contextBlockId: 'cb-spec-clean',
        };
      },
    };

    const result = await runSegmentSpecAudit(
      { specPath: '/tmp/spec.md', cwd: '/repo', autofix: true, cap: 3 },
      runtime,
    );

    expect(result).toEqual({
      specPath: '/tmp/spec.md',
      cwd: '/repo',
      roundsRun: 1,
      clean: true,
      rounds: [
        {
          round: 1,
          findingsSummary: 'clean',
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
          fixedByAgent: false,
          contextBlockId: 'cb-spec-clean',
        },
      ],
      openFindings: [],
      blockingRemaining: false,
      proceed: true,
      note: 'Spec audit cleared in round 1.',
      contextBlockId: 'cb-spec-clean',
    });
    expect(calls).toEqual(['mma-audit']);
  });

  it('caps the spec audit loop at three rounds and blocks when critical findings remain', async () => {
    const { runSegmentSpecAudit } = await import(specSegmentPath);
    let audits = 0;
    let fixes = 0;
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        if (request.skill === 'mma-audit') {
          audits += 1;
          return {
            findingsSummary: `round ${audits}`,
            findings: [`critical-${audits}`],
            counts: { critical: 1, high: 0, medium: 0, low: 0 },
            contextBlockId: `cb-spec-${audits}`,
          };
        }
        fixes += 1;
        return { applied: true };
      },
    };

    const result = await runSegmentSpecAudit(
      { specPath: '/tmp/spec.md', cwd: '/repo', autofix: true, cap: 3 },
      runtime,
    );

    expect(audits).toBe(3);
    expect(fixes).toBe(2);
    expect(result.roundsRun).toBe(3);
    expect(result.clean).toBe(false);
    expect(result.blockingRemaining).toBe(true);
    expect(result.proceed).toBe(false);
    expect(result.openFindings).toEqual(['round 3']);
    expect(result.note).toContain('Critical or high findings remain after round 3');
  });

  it('runs the plan audit loop with the same shared policy shape', async () => {
    const { runSegmentPlanAudit } = await import(planSegmentPath);
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async () => ({
        findingsSummary: 'plan clean',
        findings: [],
        counts: { critical: 0, high: 0, medium: 1, low: 2 },
        contextBlockId: 'cb-plan-clean',
      }),
    };

    const result = await runSegmentPlanAudit(
      { planPath: '/tmp/plan.md', cwd: '/repo', autofix: false, cap: 3 },
      runtime,
    );

    expect(result.planPath).toBe('/tmp/plan.md');
    expect(result.cwd).toBe('/repo');
    expect(result.roundsRun).toBe(1);
    expect(result.clean).toBe(true);
    expect(result.proceed).toBe(true);
    expect(result.blockingRemaining).toBe(false);
    expect(result.rounds[0]).toMatchObject({
      round: 1,
      findingsSummary: 'plan clean',
      criticalCount: 0,
      highCount: 0,
      mediumCount: 1,
      lowCount: 2,
      fixedByAgent: false,
      contextBlockId: 'cb-plan-clean',
    });
  });
});
