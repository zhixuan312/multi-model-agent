import { describe, expect, it } from 'vitest';
import { taskInputSchema, canonicalContractDigest } from '@zhixuan92/multi-model-agent-core';

/**
 * `deliverable` eligibility, per route.
 *
 * The task-input union is a STRICT discriminated union, so each arm must opt in to
 * `deliverable` individually. A missing `...deliverableField` on one arm is therefore a silent
 * per-route defect: the other three arms keep working, and only that one route rejects a valid
 * contract as an unrecognised key. The retired technique-selector field's eligibility used to
 * have this shape of test (all four routes plus the `audit` rejection); the equivalent for
 * `deliverable` was asserted for `plan` alone, which left three accepting routes and every
 * rejecting route unlocked.
 *
 * The two lists differ on purpose and the difference is load-bearing: `debug` never carries a
 * contract, because diagnosis is not a delivery stage.
 */

const CONTENT = {
  kind: 'quarterly finance report',
  audience: 'the finance review committee',
  artifacts: [{ root: 'workspaceRoot', path: 'report.md' }],
  acceptance: [
    {
      id: 'AC-1',
      criterion: 'the figures tie to the source ledger',
      method: 'human' as const,
      references: [{ kind: 'none', reason: 'internal reconciliation, no external standard' }],
    },
  ],
  disposition: 'deliver-file' as const,
};

const APPROVED = {
  state: 'approved' as const,
  ...CONTENT,
  contractApproval: {
    contractDigest: canonicalContractDigest(CONTENT),
    approvedBy: 'the finance lead',
    approvedAt: '2026-08-09T00:00:00.000Z',
  },
};

/** A minimal valid body per route, so a failure means the `deliverable` field and nothing else. */
const BODY: Record<string, Record<string, unknown>> = {
  spec: { type: 'spec', prompt: 'produce the report spec', target: { inline: 'decisions' } },
  plan: { type: 'plan', prompt: 'plan the report', target: { inline: 'spec' } },
  execute_plan: { type: 'execute_plan', target: { paths: ['plan.md'] }, tasks: [] },
  review: { type: 'review', target: { inline: 'draft' } },
  debug: { type: 'debug', prompt: 'the figure does not tie to source' },
  investigate: { type: 'investigate', prompt: 'what does the ledger contain' },
  audit: { type: 'audit', target: { inline: 'doc' } },
  delegate: { type: 'delegate', prompt: 'write the summary' },
  research: { type: 'research', prompt: 'what disclosure standards apply to this report' },
};

/** The four SDLC routes a contract governs (task-input-schema.ts). */
const ACCEPTS = ['spec', 'plan', 'execute_plan', 'review'];
/** Every other route, including `debug` — never a contract. */
const REJECTS = ['debug', 'investigate', 'audit', 'delegate', 'research'];

describe('deliverable eligibility per route', () => {
  it('every route body is valid WITHOUT a deliverable, so the field is the only variable', () => {
    for (const route of [...ACCEPTS, ...REJECTS]) {
      const result = taskInputSchema.safeParse(BODY[route]);
      expect(result.success, `${route} base body must be valid: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('accepts an approved contract on exactly the four SDLC routes', () => {
    for (const route of ACCEPTS) {
      const result = taskInputSchema.safeParse({ ...BODY[route], deliverable: APPROVED });
      expect(result.success, `${route} must accept deliverable: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  it('rejects a deliverable on every other route, including debug', () => {
    for (const route of REJECTS) {
      const result = taskInputSchema.safeParse({ ...BODY[route], deliverable: APPROVED });
      expect(result.success, `${route} must NOT accept deliverable`).toBe(false);
    }
  });

  it('rejects a non-approved contract on an accepting route', () => {
    // Only `approved` crosses the wire; `proposed` is a spec/plan-stage state.
    const proposed = { state: 'proposed', ...CONTENT };
    for (const route of ACCEPTS) {
      expect(taskInputSchema.safeParse({ ...BODY[route], deliverable: proposed }).success,
        `${route} must reject a proposed contract`).toBe(false);
    }
  });

  it('rejects a digest that does not cover the contract content, on every accepting route', () => {
    const tampered = { ...APPROVED, kind: 'a different deliverable entirely' };
    for (const route of ACCEPTS) {
      expect(taskInputSchema.safeParse({ ...BODY[route], deliverable: tampered }).success,
        `${route} must reject a digest mismatch`).toBe(false);
    }
  });
});
