import { z } from 'zod';

// Event-specific Zod base schemas. Closed enums used by these schemas
// live at types/enums.ts (the canonical location per architecture.md:209
// — "types/enums.ts mirrors enums.md (Zod schemas)"). This file keeps
// only the per-event-family object bases (TaskBase, BatchBase) plus
// re-exports of the enums that observability-events.ts and
// cloud-events.ts compose into event schemas.

/** Shared base for task-level events (has taskIndex). */
export const TaskBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
  taskIndex: z.number().int().min(0),
});

/** Shared base for batch-level events (no taskIndex). */
export const BatchBase = z.object({
  ts: z.string().datetime({ offset: true }),
  batchId: z.string().uuid(),
});

// Re-export enums from the canonical types/enums.ts. Production callers
// already import from this file; the re-export keeps those imports stable
// while enabling new code (and the closed-enum ratchet tests under
// tests/events/) to import from types/enums.ts directly.
export {
  TierEnum,
  RouteEnum,
  ProviderTypeEnum,
  RunStatusEnum,
  ReviewVerdictEnum,
  VerifyOutcomeEnum,
  VerifySkipReasonEnum,
  WorkerStatusEnum,
  ReviewEngineTypeEnum,
  EvidenceKindEnum,
  IncompleteReasonEnum,
  InvestigationConfidenceEnum,
  FindingConfidenceSchema,
  ResearchAdapterEnum,
  EventTypeEnum,
  DiagLoopEnum,
  DiagRoleEnum,
  DiagReasonEnum,
} from '../types/enums.js';
