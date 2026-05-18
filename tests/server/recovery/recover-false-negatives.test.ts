import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg.Client
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockEnd = vi.fn();
vi.mock('pg', () => ({
  Client: vi.fn(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

import { recoverFalseNegatives } from '../../../packages/server/src/recovery/recover-false-negatives.js';

beforeEach(() => {
  mockQuery.mockReset(); mockConnect.mockReset(); mockEnd.mockReset();
  mockConnect.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
});

function fakeFalseNegativeRow(id: number) {
  return {
    id,
    event: {
      route: 'delegate',
      reviewPolicy: 'full',
      concernCount: 0,
      stages: [
        { name: 'implementing', outcome: 'advance' },
        { name: 'review', verdict: 'approved', outcome: 'advance' },
        { name: 'committing', outcome: 'advance', branchCreated: false, filesCommittedCount: 1 },
      ],
    },
    original_terminal_status: 'error',
    original_worker_status: 'failed',
    original_error_code: 'review_quality_findings_unresolved',
  };
}

describe('recoverFalseNegatives', () => {
  it('case 1: dry-run on false-negative row prints diff, no DB writes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeFalseNegativeRow(1)] }).mockResolvedValueOnce({ rows: [] });
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: false, pageSize: 500 });
    expect(summary.updated).toBe(1);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(/^UPDATE/), expect.anything());
  });

  it('case 2: apply writes the UPDATEs and sets recovered_at', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // ALTER TABLE
      .mockResolvedValueOnce({ rows: [fakeFalseNegativeRow(1)] })  // SELECT page 1
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({ rows: [] })  // UPDATE
      .mockResolvedValueOnce({ rows: [] })  // COMMIT
      .mockResolvedValueOnce({ rows: [] });  // SELECT page 2 (empty)
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: true, pageSize: 500 });
    expect(summary.updated).toBe(1);
    expect(summary.pagesProcessed).toBe(1);
    const updateCall = mockQuery.mock.calls.find((c) => /^UPDATE/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).toEqual(['ok', 'done', null, 1]);
  });

  it('case 3: malformed row (no review stage) is skipped', async () => {
    const malformed = { id: 99, event: { route: 'delegate', reviewPolicy: 'full', stages: [{ name: 'implementing', outcome: 'advance' }] } };
    mockQuery.mockResolvedValueOnce({ rows: [malformed] }).mockResolvedValueOnce({ rows: [] });
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: false, pageSize: 500 });
    expect(summary.skippedMalformed).toBe(1);
    expect(summary.skippedMalformedIds).toContain(99);
  });

  it('case 4: row with reviewVerdict=changes_required + no rework is a legit failure (not updated)', async () => {
    const legit = {
      id: 5,
      event: {
        route: 'delegate', reviewPolicy: 'full', concernCount: 1,
        stages: [
          { name: 'implementing', outcome: 'advance' },
          { name: 'review', verdict: 'changes_required', outcome: 'advance' },
          { name: 'committing', outcome: 'advance', branchCreated: false, filesCommittedCount: 1 },
          // no rework stage
        ],
      },
    };
    mockQuery.mockResolvedValueOnce({ rows: [legit] }).mockResolvedValueOnce({ rows: [] });
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: false, pageSize: 500 });
    expect(summary.legitFailures).toBe(1);
    expect(summary.updated).toBe(0);
  });

  it('case 5: --page-size honored across 3 pages of 100 rows each', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fakeFalseNegativeRow(i));
    const page2 = Array.from({ length: 100 }, (_, i) => fakeFalseNegativeRow(100 + i));
    const page3 = Array.from({ length: 50 }, (_, i) => fakeFalseNegativeRow(200 + i));
    mockQuery
      .mockResolvedValueOnce({ rows: page1 })
      .mockResolvedValueOnce({ rows: page2 })
      .mockResolvedValueOnce({ rows: page3 })
      .mockResolvedValueOnce({ rows: [] });
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: false, pageSize: 100 });
    expect(summary.candidates).toBe(250);
    expect(summary.updated).toBe(250);
    expect(summary.pagesProcessed).toBe(3);
  });

  it('case 6: row where concernCount > 0 → worker_status=done_with_concerns', async () => {
    const withConcerns = {
      ...fakeFalseNegativeRow(7),
      event: { ...fakeFalseNegativeRow(7).event, concernCount: 2 },
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [] })   // ALTER TABLE
      .mockResolvedValueOnce({ rows: [withConcerns] })
      .mockResolvedValueOnce({ rows: [] })   // BEGIN
      .mockResolvedValueOnce({ rows: [] })   // UPDATE
      .mockResolvedValueOnce({ rows: [] })   // COMMIT
      .mockResolvedValueOnce({ rows: [] });  // SELECT empty
    const summary = await recoverFalseNegatives({ dbUrl: 'postgres://x', since: '2026-05-01', apply: true, pageSize: 500 });
    expect(summary.updated).toBe(1);
    const updateCall = mockQuery.mock.calls.find((c) => /^UPDATE/.test(c[0]));
    expect(updateCall![1]).toEqual(['ok', 'done_with_concerns', null, 7]);
  });
});
