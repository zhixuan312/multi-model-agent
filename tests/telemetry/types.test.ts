import { describe, it, expect } from 'vitest';
import {
  TelemetryEvent,
  UploadBatch,
  SCHEMA_VERSION,
} from '../../packages/core/src/telemetry/types.js';

// Use a model ID that's actually in the KnownModelId enum from model-profiles
// 'claude-sonnet' is a valid prefix entry in model-profiles.json
const VALID_MODEL = 'claude-sonnet';

function makeValidTaskCompleted(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'task.completed',
    eventId: '00000000-0000-4000-a000-000000000001',
    route: 'delegate',
    agentType: 'standard',
    capabilities: [],
    toolMode: 'full',
    triggeredFromSkill: 'mma-delegate',
    client: 'claude-code',
    fileCountBucket: '1-5',
    durationBucket: '10s-1m',
    costBucket: '$0.01-$0.10',
    savedCostBucket: 'unknown',
    implementerModelFamily: 'claude',
    implementerModel: VALID_MODEL,
    terminalStatus: 'ok',
    workerStatus: 'done',
    errorCode: null,
    escalated: false,
    fallbackTriggered: false,
    topToolNames: [],
    stages: {
      implementing: {
        entered: true,
        durationBucket: '10s-1m',
        costBucket: '$0.01-$0.10',
        agentTier: 'standard',
        modelFamily: 'claude',
        model: VALID_MODEL,
      },
      verifying: {
        entered: true,
        durationBucket: '<10s',
        costBucket: '$0',
        agentTier: 'standard',
        modelFamily: 'claude',
        model: VALID_MODEL,
        outcome: 'passed',
        skipReason: null,
      },
      spec_review: {
        entered: true,
        durationBucket: '<10s',
        costBucket: '$0',
        agentTier: 'standard',
        modelFamily: 'claude',
        model: VALID_MODEL,
        verdict: 'approved',
        roundsUsed: '1',
        concernCategories: [],
      },
      spec_rework: {
        entered: false,
        durationBucket: null,
        costBucket: null,
        agentTier: null,
        modelFamily: null,
        model: null,
      },
      quality_review: {
        entered: true,
        durationBucket: '<10s',
        costBucket: '$0',
        agentTier: 'standard',
        modelFamily: 'claude',
        model: VALID_MODEL,
        verdict: 'approved',
        roundsUsed: '1',
        concernCategories: [],
      },
      quality_rework: {
        entered: false,
        durationBucket: null,
        costBucket: null,
        agentTier: null,
        modelFamily: null,
        model: null,
      },
      committing: {
        entered: true,
        durationBucket: '<10s',
        costBucket: '$0',
        agentTier: 'standard',
        modelFamily: 'claude',
        model: VALID_MODEL,
      },
    },
    ...overrides,
  };
}

describe('telemetry/types', () => {
  it('SCHEMA_VERSION is 1 (3.6.0 baseline)', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('accepts a well-formed task.completed event', () => {
    const event = makeValidTaskCompleted();
    expect(() => TelemetryEvent.parse(event)).not.toThrow();
  });

  // R1 — terminalStatus=ok requires errorCode=null
  it('R1 — terminalStatus=ok requires errorCode=null', () => {
    const event = makeValidTaskCompleted({
      terminalStatus: 'ok',
      workerStatus: 'done',
      errorCode: 'api_error',
    });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('errorCode=null'))).toBe(true);
    }
  });

  // R1 — terminalStatus=ok requires valid workerStatus
  it('R1 — terminalStatus=ok requires workerStatus done|done_with_concerns', () => {
    const event = makeValidTaskCompleted({
      terminalStatus: 'ok',
      workerStatus: 'failed',
      errorCode: null,
    });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('workerStatus'))).toBe(true);
    }
  });

  // R2 — non-verify route cannot have a real verify outcome
  it('R2 — non-verify route cannot have a real verify outcome', () => {
    const event = makeValidTaskCompleted({
      route: 'audit',
      stages: {
        ...makeValidTaskCompleted().stages,
        verifying: {
          entered: true,
          durationBucket: '10s-1m',
          costBucket: '$0.01-$0.10',
          agentTier: 'standard',
          modelFamily: null,
          model: null,
          outcome: 'passed',
          skipReason: null,
        },
      },
    });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('verifying'))).toBe(true);
    }
  });

  // R3 — non-reviewed route must have spec/quality/diff entered=false
  it('R3 — non-reviewed route must have spec/quality/diff entered=false', () => {
    const base = makeValidTaskCompleted() as Record<string, unknown>;
    const event = {
      ...base,
      route: 'audit',
      stages: {
        ...((base.stages as Record<string, unknown>) || {}),
        spec_review: {
          entered: true,
          durationBucket: '10s-1m',
          costBucket: '$0.01-$0.10',
          agentTier: 'standard',
          modelFamily: 'claude',
          model: 'claude-sonnet',
          verdict: 'approved',
          roundsUsed: '1',
          concernCategories: [],
        },
      },
    };
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i: { message: string }) => i.message);
      expect(messages.some((m: string) => m.includes('spec_review.entered must be false'))).toBe(true);
    }
  });

  // R4 — entered=false stages must have null sub-fields including verdict/outcome
  it('R4 — entered=false stages must have null sub-fields including verdict/outcome', () => {
    const base = makeValidTaskCompleted() as Record<string, unknown>;
    const event = {
      ...base,
      stages: {
        ...((base.stages as Record<string, unknown>) || {}),
        spec_rework: {
          entered: false,
          durationBucket: '10s-1m', // should be null
          costBucket: null,
          agentTier: null,
          modelFamily: null,
          model: null,
        },
      },
    };
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('sub-fields must be null'))).toBe(true);
    }
  });

  // R5 — entered=true requires durationBucket/costBucket and stage-type fields non-null
  it('R5 — entered=true requires durationBucket/costBucket and stage-type fields non-null', () => {
    const base = makeValidTaskCompleted() as Record<string, unknown>;
    const event = {
      ...base,
      stages: {
        ...((base.stages as Record<string, unknown>) || {}),
        implementing: {
          entered: true,
          durationBucket: null, // should be non-null
          costBucket: null,
          agentTier: 'standard',
          modelFamily: 'claude',
          model: 'claude-sonnet',
        },
      },
    };
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i: { message: string }) => i.message);
      expect(messages.some((m: string) => m.includes('base sub-fields must be non-null'))).toBe(true);
    }
  });

  // R5 — entered=true verify stage requires outcome non-null
  it('R5 — entered=true verify stage requires outcome non-null', () => {
    const base = makeValidTaskCompleted() as Record<string, unknown>;
    const event = {
      ...base,
      stages: {
        ...((base.stages as Record<string, unknown>) || {}),
        verifying: {
          entered: true,
          durationBucket: '<10s',
          costBucket: '$0',
          agentTier: 'standard',
          modelFamily: null,
          model: null,
          outcome: null, // should be non-null when entered=true
          skipReason: null,
        },
      },
    };
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('outcome must be non-null'))).toBe(true);
    }
  });

  // R5 — outcome=skipped requires skipReason non-null
  it('R5 — outcome=skipped requires skipReason non-null', () => {
    const base = makeValidTaskCompleted() as Record<string, unknown>;
    const event = {
      ...base,
      stages: {
        ...((base.stages as Record<string, unknown>) || {}),
        verifying: {
          entered: true,
          durationBucket: '<10s',
          costBucket: '$0',
          agentTier: 'standard',
          modelFamily: null,
          model: null,
          outcome: 'skipped',
          skipReason: null, // should be non-null
        },
      },
    };
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message);
      expect(messages.some(m => m.includes('skipReason must be non-null'))).toBe(true);
    }
  });

  it('accepts any valid BoundedIdentifier as skill ID', () => {
    const event = makeValidTaskCompleted({ triggeredFromSkill: 'unknown-skill' });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(true);
  });

  it('rejects oversized strings', () => {
    const event = makeValidTaskCompleted({
      implementerModel: 'a'.repeat(1000),
    });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('rejects non-unique capability arrays', () => {
    const event = makeValidTaskCompleted({
      capabilities: ['web_search', 'web_search'],
    });
    const result = TelemetryEvent.safeParse(event);
    expect(result.success).toBe(false);
  });

  it('UploadBatch caps at 500 events and floors at 1', () => {
    const event = makeValidTaskCompleted();
    const validEvent = TelemetryEvent.parse(event);

    // 0 events → fails
    const empty = {
      schemaVersion: 1 as const,
      install: {
        installId: '00000000-0000-4000-a000-000000000001',
        mmagentVersion: '3.6.0',
        os: 'darwin',
        nodeMajor: '22',
        language: 'en',
        tzOffsetBucket: 'utc_0_to_plus_6',
      },
      events: [],
    };
    expect(() => UploadBatch.parse(empty)).toThrow();

    // 1 event → ok
    const one = { ...empty, events: [validEvent] };
    expect(() => UploadBatch.parse(one)).not.toThrow();

    // 500 events → ok
    const many = { ...empty, events: Array(500).fill(validEvent) };
    expect(() => UploadBatch.parse(many)).not.toThrow();

    // 501 events → fails
    const tooMany = { ...empty, events: Array(501).fill(validEvent) };
    expect(() => UploadBatch.parse(tooMany)).toThrow();
  });
});
