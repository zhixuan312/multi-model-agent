import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/**
 * Permissive shape-only validation for fields whose vocabulary we don't control:
 * model IDs, client names, MCP tool names, skill IDs. Charset accommodates every
 * model namespace observed in the wild (Anthropic, OpenAI, Bedrock prefixes,
 * OpenRouter `meta-llama/...`, Ollama `model:tag`). Length cap prevents PII
 * smuggling. The schema validates SHAPE, not VOCABULARY.
 */
export const BoundedIdentifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:/\-]+$/);

const MAX_STR = 64;
const MAX_VERSION_STR = 64;

const VersionString = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  )
  .max(MAX_VERSION_STR);

// Allowlists. Two skill enums: triggering source vs installable skill.
// 'direct' is only meaningful for triggering (no skill caller); it cannot be installed.
export const InstallableSkillId = z.enum([
  'mma-delegate',
  'mma-audit',
  'mma-review',
  'mma-verify',
  'mma-debug',
  'mma-execute-plan',
  'mma-retry',
  'mma-investigate', // present on disk under packages/server/src/skills/
  'mma-context-blocks',
  'mma-clarifications',
  'other', // sentinel for unknown / community skill
]);

export const TriggeringSkillId = z.union([InstallableSkillId, z.literal('direct')]);

export const ClientId = BoundedIdentifier;

export const ModelFamily = z.enum([
  'claude',     // Anthropic
  'openai',     // OpenAI
  'gemini',     // Google
  'deepseek',   // DeepSeek
  'grok',       // xAI
  'mistral',    // Mistral
  'meta',       // Meta (Llama family — covers llama2:7b, meta-llama/..., etc.)
  'qwen',       // Alibaba
  'zhipu',      // Z.ai (GLM family)
  'kimi',       // Moonshot
  'minimax',    // MiniMax
  'other',      // catch-all — never rejected
] as const);
export type ModelFamilyType = z.infer<typeof ModelFamily>;

export const Language = z.enum([
  'en',
  'es',
  'fr',
  'de',
  'zh',
  'ja',
  'ko',
  'pt',
  'ru',
  'it',
  'tr',
  'ar',
  'hi',
  'vi',
  'id',
  'th',
  'pl',
  'nl',
  'sv',
  'other',
]);

// Time-zone offset buckets, fully covering UTC-12 through UTC+14, half-open [a, b).
export const TzOffsetBucket = z.enum([
  'utc_minus_12_to_minus_6', // [-12, -6)
  'utc_minus_6_to_0', // [-6, 0)
  'utc_0_to_plus_6', // [0, +6)
  'utc_plus_6_to_plus_12', // [+6, +12)
  'utc_plus_12_to_plus_15', // [+12, +15)  -- covers UTC+12, +12:45, +13, +14
]);

export const Os = z.enum(['darwin', 'linux', 'win32', 'other']); // matches process.platform; non-listed → 'other'

export const InstallMetadata = z.object({
  installId: z.string().uuid(),
  mmagentVersion: VersionString,
  os: Os,
  nodeMajor: z.string().regex(/^[1-9]\d?$/).max(2), // "1".."99"; no leading zeros; cast to int when sorting
  language: Language, // bucketed from runtime locale, never raw
  tzOffsetBucket: TzOffsetBucket,
}).strict();

// Allowlist of tool names that may appear in topToolNames. Anything else → 'other'.
// This is the SDK-level tool surface from packages/core/src/tools/definitions.ts;
// the canonical names used here are the camelCase internal names. The adapter-facing
// snake_case names (read_file, write_file, edit_file, run_shell, list_files) are
// normalized to camelCase by the event-builder before counting. Web search and web
// fetch are NOT separate tool names — they are surfaced via the `capabilities` field
// on TaskCompletedEvent and excluded from topToolNames.
export const AllowlistedToolName = z.enum([
  'readFile',
  'writeFile',
  'editFile',
  'runShell',
  'listFiles',
  'grep',
  'glob',
  'other',
]);

// Allowlist of error codes from packages/core/src/types.ts:RunResult.structuredError
export const ErrorCode = z.enum([
  'verify_command_error',
  'commit_metadata_invalid',
  'commit_metadata_repair_modified_files',
  'dirty_worktree',
  'diff_review_rejected',
  'runner_crash',
  'executor_error',
  'api_error',
  'network_error',
  'rate_limit_exceeded',
  'other',
]);

// Allowlist of structured concern categories surfaced by reviewers.
// Server categorizes raw concern messages into these buckets at ingest time.
export const ConcernCategory = z.enum([
  'missing_test',
  'scope_creep',
  'incomplete_impl',
  'style_lint',
  'security',
  'performance',
  'maintainability',
  'doc_gap',
  'other',
]);

// Per-stage breakdown — populated for stages the task actually entered.
// Each sub-object is null when the stage was not entered.
export const StageStats = z.object({
  entered: z.boolean(),
  durationBucket: z.enum(['<10s', '10s-1m', '1m-5m', '5m-30m', '30m+']).nullable(),
  costBucket: z.enum(['$0', '<$0.01', '$0.01-$0.10', '$0.10-$1', '$1+']).nullable(),
  agentTier: z.enum(['standard', 'complex']).nullable(),
  modelFamily: ModelFamily.nullable(),
  model: BoundedIdentifier.nullable(),
}).strict();

// Reviewer stages add verdict + round + concern categories.
export const ReviewStageStats = StageStats.extend({
  verdict: z
    .enum(['approved', 'concerns', 'changes_required', 'error', 'skipped', 'not_applicable'])
    .nullable(),
  roundsUsed: z.enum(['0', '1', '2+']).nullable(),
  concernCategories: z
    .array(ConcernCategory)
    .max(9)
    .nullable(), // categorized server-side; never raw text. Cap matches the ConcernCategory enum cardinality so a stage that surfaced every distinct category isn't silently truncated.
});

// Verify stage adds outcome + skip reason.
export const VerifyStageStats = StageStats.extend({
  outcome: z.enum(['passed', 'failed', 'skipped', 'not_applicable']).nullable(),
  skipReason: z.enum(['no_command', 'dirty_worktree', 'not_applicable', 'other']).nullable(),
});

export const TaskCompletedEvent = z.object({
  type: z.literal('task.completed'),
  // Route shape
  route: z.enum(['delegate', 'audit', 'review', 'verify', 'debug', 'execute-plan', 'retry']),
  agentType: z.enum(['standard', 'complex']),
  capabilities: z
    .array(z.enum(['web_search', 'web_fetch', 'other']))
    .max(3)
    .refine(xs => new Set(xs).size === xs.length, 'unique'),
  toolMode: z.enum(['none', 'readonly', 'no-shell', 'full']),
  triggeredFromSkill: BoundedIdentifier, // 'direct' for non-skill invocations
  client: ClientId, // which agent client invoked us
  // Task shape (derived from structured task metadata; never from prompt parsing or fs scanning)
  fileCountBucket: z.enum(['0', '1-5', '6-20', '21-50', '51+']),
  durationBucket: z.enum(['<10s', '10s-1m', '1m-5m', '5m-30m', '30m+']),
  costBucket: z.enum(['$0', '<$0.01', '$0.01-$0.10', '$0.10-$1', '$1+']),
  savedCostBucket: z.enum(['$0', '<$0.10', '$0.10-$1', '$1+', 'unknown']),
  // Implementer model summary (top-level convenience; per-stage detail lives in `stages`)
  implementerModelFamily: ModelFamily,
  implementerModel: BoundedIdentifier,
  // Outcome
  terminalStatus: z.enum([
    'ok',
    'incomplete',
    'timeout',
    'error',
    'cost_exceeded',
    'brief_too_vague',
    'unavailable',
  ]),
  workerStatus: z.enum([
    'done',
    'done_with_concerns',
    'needs_context',
    'blocked',
    'failed',
    'review_loop_aborted',
  ]),
  errorCode: ErrorCode.nullable(), // populated when terminalStatus is a failure mode
  // 3.5.0 lifecycle effectiveness
  escalated: z.boolean(),
  fallbackTriggered: z.boolean(),
  // Tool-call profile — top 5 distinct tool names called during this task by count
  // (allowlisted; non-listed tools become 'other'; never includes args/paths)
  topToolNames: z.array(BoundedIdentifier).max(20),
  // Per-stage breakdown — drives the lifecycle funnel + per-stage panels
  stages: z.object({
    implementing: StageStats,
    verifying: VerifyStageStats,
    spec_review: ReviewStageStats,
    spec_rework: StageStats, // implementer re-runs after spec changes_required
    quality_review: ReviewStageStats,
    quality_rework: StageStats,
    diff_review: ReviewStageStats.optional(), // diff-only policy; not always present
    committing: StageStats,
  }).strict(),
}).strict();

export const SessionStartedEvent = z.object({
  type: z.literal('session.started'),
  configFlavor: z.object({
    defaultTier: z.enum(['standard', 'complex']),
    diagnosticsEnabled: z.boolean(),
    autoUpdateSkills: z.boolean(),
  }).strict(),
  providersConfigured: z
    .array(z.enum(['claude', 'openai-compatible', 'codex']))
    .max(3)
    .refine(xs => new Set(xs).size === xs.length, 'unique'),
}).strict();

export const InstallChangedEvent = z.object({
  type: z.literal('install.changed'),
  fromVersion: VersionString.nullable(),
  toVersion: VersionString,
  trigger: z.enum(['fresh_install', 'upgrade', 'downgrade']),
}).strict();

export const SkillInstalledEvent = z.object({
  type: z.literal('skill.installed'),
  skill: InstallableSkillId, // 'direct' is NOT a skill, rejected here
  client: ClientId,
}).strict();

// Discriminated union, with eventId for at-most-once dedup within retention window.
// .superRefine() enforces internal consistency (see 4.4 for the rules).
const TelemetryEventBase = z.object({ eventId: z.string().uuid() }).strict();

export const TelemetryEvent = z
  .discriminatedUnion('type', [
    TaskCompletedEvent.merge(TelemetryEventBase),
    SessionStartedEvent.merge(TelemetryEventBase),
    InstallChangedEvent.merge(TelemetryEventBase),
    SkillInstalledEvent.merge(TelemetryEventBase),
  ])
  .superRefine((event, ctx) => {
    if (event.type !== 'task.completed') return;
    // R1: ok terminalStatus implies non-failed worker outcome and no errorCode
    if (event.terminalStatus === 'ok') {
      if (!['done', 'done_with_concerns'].includes(event.workerStatus)) {
        ctx.addIssue({
          code: 'custom',
          message: 'terminalStatus=ok requires workerStatus done|done_with_concerns',
        });
      }
      if (event.errorCode !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'terminalStatus=ok requires errorCode=null',
        });
      }
    }
    // R2: verify only applies to routes that exercise the verify stage
    const verifyApplicableRoutes = new Set(['delegate', 'execute-plan', 'verify']);
    const verifyOutcome = event.stages.verifying.outcome;
    if (
      !verifyApplicableRoutes.has(event.route) &&
      verifyOutcome !== null &&
      verifyOutcome !== 'not_applicable'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'stages.verifying.outcome must be null or not_applicable for non-verify routes',
      });
    }
    // R3: spec/quality/diff review only on routes that go through the reviewed lifecycle
    const reviewedRoutes = new Set(['delegate', 'execute-plan']);
    if (!reviewedRoutes.has(event.route)) {
      if (event.stages.spec_review.entered) {
        ctx.addIssue({
          code: 'custom',
          message: 'stages.spec_review.entered must be false for non-reviewed routes',
        });
      }
      if (event.stages.quality_review.entered) {
        ctx.addIssue({
          code: 'custom',
          message: 'stages.quality_review.entered must be false for non-reviewed routes',
        });
      }
      if (event.stages.diff_review?.entered) {
        ctx.addIssue({
          code: 'custom',
          message:
            'stages.diff_review.entered must be false (or stages.diff_review absent) for non-reviewed routes',
        });
      }
    }
    // R4: stage sub-fields must be null when entered=false
    // (`stages.diff_review` is `.optional()` and is omitted from the parsed
    // object entirely when absent — Object.entries doesn't surface it as
    // `[name, undefined]`. The `!st` guard is defensive belt-and-suspenders
    // that also covers the case where a future schema change makes the
    // field nullable rather than optional.)
    for (const [name, st] of Object.entries(event.stages)) {
      if (!st) continue;
      if (!st.entered) {
        // All five `StageStats` nullable fields must be null when the stage was not entered.
        const baseDirty =
          st.durationBucket !== null ||
          st.costBucket !== null ||
          st.agentTier !== null ||
          st.modelFamily !== null ||
          st.model !== null;
        // Extended fields on review / verify stages must also be null when entered=false.
        const reviewDirty =
          ('verdict' in st && (st as Record<string, unknown>).verdict !== null) ||
          ('roundsUsed' in st && (st as Record<string, unknown>).roundsUsed !== null) ||
          ('concernCategories' in st &&
            (st as Record<string, unknown>).concernCategories !== null);
        const verifyDirty =
          ('outcome' in st && (st as Record<string, unknown>).outcome !== null) ||
          ('skipReason' in st && (st as Record<string, unknown>).skipReason !== null);
        if (baseDirty || reviewDirty || verifyDirty) {
          ctx.addIssue({
            code: 'custom',
            message: `stages.${name} sub-fields must be null when entered=false`,
          });
        }
      }
    }
    // R5: when entered=true, the base bucketed fields plus the stage-type-specific
    // fields must be non-null (the stage actually ran, so it produced cost/duration
    // and a verdict/outcome). `skipReason` is exempt — it is legitimately null
    // unless `outcome === 'skipped'`. `concernCategories` is exempt — a clean
    // verdict legitimately surfaces an empty list.
    for (const [name, st] of Object.entries(event.stages)) {
      if (!st || !st.entered) continue;
      const baseMissing =
        st.durationBucket === null ||
        st.costBucket === null ||
        st.agentTier === null ||
        st.modelFamily === null ||
        st.model === null;
      if (baseMissing) {
        ctx.addIssue({
          code: 'custom',
          message: `stages.${name} base sub-fields must be non-null when entered=true`,
        });
      }
      if ('verdict' in st && (st as Record<string, unknown>).verdict === null) {
        ctx.addIssue({
          code: 'custom',
          message: `stages.${name}.verdict must be non-null when entered=true`,
        });
      }
      if ('roundsUsed' in st && (st as Record<string, unknown>).roundsUsed === null) {
        ctx.addIssue({
          code: 'custom',
          message: `stages.${name}.roundsUsed must be non-null when entered=true`,
        });
      }
      if ('outcome' in st && (st as Record<string, unknown>).outcome === null) {
        ctx.addIssue({
          code: 'custom',
          message: `stages.${name}.outcome must be non-null when entered=true`,
        });
      }
      if (
        'outcome' in st &&
        (st as Record<string, unknown>).outcome === 'skipped' &&
        (st as Record<string, unknown>).skipReason === null
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `stages.${name}.skipReason must be non-null when outcome='skipped'`,
        });
      }
    }
  });

// The complete uploadable envelope.
export const UploadBatch = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  install: InstallMetadata,
  events: z.array(TelemetryEvent).min(1).max(500),
}).strict();

// Inferred TS types — consumers do not depend on Zod's runtime types
export type TelemetryEventType = z.infer<typeof TelemetryEvent>;
export type UploadBatchType = z.infer<typeof UploadBatch>;
export type InstallMetadataType = z.infer<typeof InstallMetadata>;
export type TaskCompletedEventType = z.infer<typeof TaskCompletedEvent>;
export type SessionStartedEventType = z.infer<typeof SessionStartedEvent>;
export type InstallChangedEventType = z.infer<typeof InstallChangedEvent>;
export type SkillInstalledEventType = z.infer<typeof SkillInstalledEvent>;
export type ConcernCategoryType = z.infer<typeof ConcernCategory>;
export type ClientIdType = z.infer<typeof ClientId>;
export type InstallableSkillIdType = z.infer<typeof InstallableSkillId>;
export type ErrorCodeType = z.infer<typeof ErrorCode>;
