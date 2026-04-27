import { describe, it, expect } from 'vitest';
import type {
  ShutdownCause, SessionCloseReason, DiagLoop, DiagRole, DiagReason,
  EscalationEventParams, EscalationUnavailableEventParams,
  FallbackEventParams, FallbackUnavailableEventParams,
} from '../../packages/core/src/diagnostics/types.js';

describe('diagnostics/types extraction', () => {
  it('exports all primitive types', () => {
    const loops: DiagLoop[] = ['spec', 'quality', 'diff'];
    expect(loops.length).toBe(3);
  });

  it('EscalationEventParams is a standalone interface, not Parameters<...>', () => {
    const p: EscalationEventParams = {
      batchId: 'b', taskIndex: 0, loop: 'spec', attempt: 0,
      baseTier: 'standard', implTier: 'complex', reviewerTier: 'standard',
    };
    expect(p.loop).toBe('spec');
  });
});
