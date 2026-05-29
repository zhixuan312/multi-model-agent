import { describe, it, expect, vi } from 'bun:test';
import { parseFindings } from '../../packages/core/src/lifecycle/findings-parser.js';

describe('parseFindings — structured warnings for dropped blocks', () => {
  it('emits missing_core_bullet warning when a Finding is missing Severity bullet', () => {
    const warnSink = vi.fn();
    parseFindings(`## Finding 1: claim text\n- Category: x\n- Evidence: y\n- Suggestion: z`, 'audit-c1', ['found', 'clean'], warnSink);
    expect(warnSink).toHaveBeenCalledWith('findings_parser_drop', expect.objectContaining({
      route: 'audit-c1',
      droppedFindingHeading: 'Finding 1: claim text',
      reasonCode: 'missing_core_bullet',
    }));
  });

  it('emits empty_claim warning when heading has no claim text', () => {
    const warnSink = vi.fn();
    parseFindings(`## Finding 1: \n- Severity: high\n- Category: x\n- Evidence: y\n- Suggestion: z`, 'review-c1', ['found', 'clean'], warnSink);
    expect(warnSink).toHaveBeenCalledWith('findings_parser_drop', expect.objectContaining({
      reasonCode: 'empty_claim',
    }));
  });

  it('emits invalid_severity warning when Severity is not in enum', () => {
    const warnSink = vi.fn();
    parseFindings(`## Finding 1: claim\n- Severity: blocker\n- Category: x\n- Evidence: y\n- Suggestion: z`, 'audit-c1', ['found', 'clean'], warnSink);
    expect(warnSink).toHaveBeenCalledWith('findings_parser_drop', expect.objectContaining({
      reasonCode: 'invalid_severity',
    }));
  });

  it('emits invalid_evidence_format warning for investigate with non-citation Evidence', () => {
    const warnSink = vi.fn();
    // investigate Evidence must start with file:line; this one doesn't
    parseFindings(`## Finding 1: claim\n- Severity: high\n- Category: x\n- Evidence: just some prose\n- Suggestion: z`, 'investigate-c1', ['found', 'not_applicable'], warnSink);
    expect(warnSink).toHaveBeenCalledWith('findings_parser_drop', expect.objectContaining({
      reasonCode: 'invalid_evidence_format',
    }));
  });
});
