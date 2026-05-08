import { z } from 'zod';
import { RouteEnum, TierEnum, WorkerStatusEnum } from './event-base.js';

// Mirror the existing telemetry/types.ts schemas but use `event` as the
// discriminator so they fit into the discriminated union. The TelemetrySink
// filters these by event name; fields match the v1 upload shapes.
// Task 6 extends task.completed with 11 new v2 fields.

export const TaskCompletedCloudEvent = z.object({
  event: z.literal('task.completed'),
  ts: z.string().datetime({ offset: true }),
  // v1 core fields (mirror telemetry/types.ts TaskCompletedEvent)
  route: RouteEnum,
  agentType: TierEnum,
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  client: z.string(),
  fileCountBucket: z.enum(['0', '1-5', '6-20', '21-50', '51+']),
  durationBucket: z.enum(['<10s', '10s-1m', '1m-5m', '5m-30m', '30m+']),
  costBucket: z.enum(['$0', '<$0.01', '$0.01-$0.10', '$0.10-$1', '$1+']),
  savedCostBucket: z.enum(['$0', '<$0.10', '$0.10-$1', '$1+', 'unknown']),
  implementerModelFamily: z.string(),
  implementerModel: z.string(),
  terminalStatus: z.enum([
    'ok', 'incomplete', 'timeout', 'error', 'cost_exceeded',
    'brief_too_vague', 'unavailable',
  ]),
  workerStatus: WorkerStatusEnum,
  errorCode: z.string().nullable(),
  escalated: z.boolean(),
  fallbackTriggered: z.boolean(),
  topToolNames: z.array(z.string()).max(20),
  stages: z.record(z.string(), z.unknown()),
}).passthrough();

export const SessionStartedCloudEvent = z.object({
  event: z.literal('session.started'),
  ts: z.string().datetime({ offset: true }),
  configFlavor: z.record(z.string(), z.unknown()),
  providersConfigured: z.array(z.enum(['claude', 'openai-compatible', 'codex'])).max(3),
}).passthrough();

export const InstallChangedCloudEvent = z.object({
  event: z.literal('install.changed'),
  ts: z.string().datetime({ offset: true }),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  trigger: z.enum(['fresh_install', 'upgrade', 'downgrade']),
}).passthrough();

export const SkillInstalledCloudEvent = z.object({
  event: z.literal('skill.installed'),
  ts: z.string().datetime({ offset: true }),
  skill: z.string(),
  client: z.string(),
}).passthrough();

/** Cloud-bound event discriminator values — used by TelemetrySink to filter. */
export const CLOUD_EVENT_NAMES = new Set([
  'task.completed',
  'session.started',
  'install.changed',
  'skill.installed',
] as const);
