import { describe, it, expect } from 'vitest';
import { UploadBatch } from '../../packages/core/src/telemetry/types.js';

const baseInstall = {
  installId: '11111111-1111-4111-8111-111111111111',
  mmagentVersion: '3.6.7',
  os: 'linux' as const,
  nodeMajor: '22',
  language: 'en' as const,
  tzOffsetBucket: 'utc_0_to_plus_6' as const,
};

const baseEvent = {
  type: 'task.completed' as const,
  eventId: '22222222-2222-4222-8222-222222222222',
  client: 'claude-code',
  agentType: 'standard' as const,
  capabilities: ['web_search'],
  triggeredFromSkill: 'direct',
  toolMode: 'full' as const,
  costBucket: '$0.01-$0.10' as const,
  durationBucket: '1m-5m' as const,
  fileCountBucket: '0' as const,
  savedCostBucket: '<$0.10' as const,
  errorCode: null,
  escalated: false,
  fallbackTriggered: false,
  terminalStatus: 'ok' as const,
  workerStatus: 'done' as const,
  route: 'delegate' as const,
  topToolNames: ['readFile'],
  filesWrittenBucket: '1-5' as const,
  c2Promoted: false,
  workerSelfAssessment: 'done' as const,
  concernCount: 0,
  escalationCount: 0,
  fallbackCount: 0,
  turnCountBucket: '1-3' as const,
  stallTriggered: false,
  clarificationRequested: false,
  parentModelFamily: 'claude' as const,
  briefQualityWarningCount: 0,
  stages: {
    committing:    { entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null },
    implementing:  { entered: true,  agentTier: 'standard', costBucket: '$0', durationBucket: '1m-5m', model: 'claude-sonnet-4-5', modelFamily: 'claude' },
    spec_review:   { entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null, roundsUsed: null, verdict: null, concernCategories: null },
    spec_rework:   { entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null },
    quality_review:{ entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null, roundsUsed: null, verdict: null, concernCategories: null },
    quality_rework:{ entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null },
    verifying:     { entered: false, agentTier: null, costBucket: null, durationBucket: null, model: null, modelFamily: null, outcome: null, skipReason: null },
  },
};

describe('contract: real-world permissive payloads parse cleanly', () => {
  it('Anthropic 4.5', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'claude-sonnet-4-5', implementerModelFamily: 'claude' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('Bedrock prefix', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'bedrock/anthropic.claude-3-haiku-20240307-v1:0', implementerModelFamily: 'claude' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('OpenRouter Llama-4', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', implementerModelFamily: 'meta' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('Ollama llama2:7b', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'llama2:7b', implementerModelFamily: 'meta' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('custom corp gateway', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'gpt-4-via-corp-gateway', implementerModelFamily: 'openai' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('custom MCP tool name', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'claude-sonnet-4-5', implementerModelFamily: 'claude' as const, topToolNames: ['mcp__github__create_issue', 'mcp__slack__post_message'] }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('custom client identifier', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, client: 'zed-ai', implementerModel: 'claude-sonnet-4-5', implementerModelFamily: 'claude' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(true);
  });
  it('rejects shape violation in implementerModel', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'model with spaces', implementerModelFamily: 'other' as const }] };
    expect(UploadBatch.safeParse(batch).success).toBe(false);
  });
  it('rejects unknown family value', () => {
    const batch = { schemaVersion: 2, install: baseInstall, events: [{ ...baseEvent, implementerModel: 'claude-sonnet-4-5', implementerModelFamily: 'invented-family' as any }] };
    expect(UploadBatch.safeParse(batch).success).toBe(false);
  });
});
