# Retry With Exponential Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared, deadline-aware retry-with-backoff handling for transient `429` and `503` upstream provider failures in both Claude and Codex session runners without changing caller-facing pipeline orchestration.

**Architecture:** Introduce one shared retry helper under `packages/core/src/providers/` and one provider-specific classifier module that translates raw Claude SDK errors and Codex runner failures into a common retry classification. Keep retries inside `ClaudeSession.send()` and `CodexCliSession.send()` so the unified pipeline continues to open one session and make one `send()` call per phase, while additive provider-event diagnostics expose every scheduled retry.

**Tech Stack:** TypeScript, ESM imports with `.js` specifiers from source, Vitest 3 at repo root, `pnpm` workspace scripts, Node 22 runtime.

**Ground truth at HEAD:**
- The approved spec file exists at `docs/mma/specs/2026-07-06-add-retry-with-exponential-backoff-to-provider-runners-when-.md`, but its clickable source links point at a different worktree (`79a7fff4`). The relative repo paths are correct in this worktree.
- Root test command is `pnpm vitest run` (not per-path); `docs/mma/plans/` directory now exists with this plan file.
- `packages/core/src/providers/claude-session.ts` currently performs exactly one SDK `query()` per `send()` and throws immediately on SDK errors.
- `packages/core/src/providers/codex-cli-session.ts` currently performs exactly one subprocess attempt per `send()` and returns an error `TurnResult` instead of throwing, so retry integration must preserve that external behavior.
- `packages/core/src/events/plain-log-entry.ts` currently defines **21** provider event names (8 Claude + 13 Codex); `tests/events/provider-event-mapping.test.ts` expects `.toHaveLength(21)` and golden `tests/contract/goldens/observability/event-manifest.json` lists 21. Both must update to 23 after adding 2 retry event names.
- There is already a repo precedent for deadline-aware exponential backoff in `packages/core/src/research/web-search.ts` (jitter formula: `base * (0.75 + random() * 0.5)`, deadline capping); no shared provider retry helper or provider retry-classifier module yet exists.

**File Structure:**
```text
docs/mma/plans/
└── 2026-07-06-2026-07-06-add-retry-with-exponential-backoff-to-provider-runners-when-.md

packages/core/src/events/
└── plain-log-entry.ts                         # modify

packages/core/src/providers/
├── claude-session.ts                         # modify
├── codex-cli-session.ts                      # modify
├── provider-retry-classifiers.ts             # create
└── retry-with-backoff.ts                     # create

tests/contract/goldens/observability/
└── event-manifest.json                       # modify

tests/events/
└── provider-event-mapping.test.ts            # modify

tests/providers/
├── claude-session-retry.test.ts              # create
├── codex-cli-session-retry.test.ts           # create
├── provider-retry-classifiers.test.ts        # create
└── retry-with-backoff.test.ts                # create
```

## Track I — Shared Retry Policy

### Task I-1: Shared Retry Helper (AC-2.1, AC-3.1, AC-4.1, AC-7.1)

**Files:**
- Create: `packages/core/src/providers/retry-with-backoff.ts`
- Test: `tests/providers/retry-with-backoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  BASE_BACKOFF_MS,
  MAX_RETRIES,
  retryWithBackoff,
  sleepWithAbort,
  type RetryClassification,
} from '../../packages/core/src/providers/retry-with-backoff.js';

describe('retryWithBackoff', () => {
  it('retries 429 and then returns the later success result', async () => {
    const sleep = vi.fn(async () => {});
    const emit = vi.fn();
    const classify = vi.fn((error: unknown): RetryClassification | null => {
      if ((error as Error).message === '429') {
        return { statusCode: 429, retryAfterMs: null, reason: 'status_429' };
      }
      return null;
    });

    let attempts = 0;
    const result = await retryWithBackoff({
      provider: 'claude',
      wallClockDeadline: 20_000,
      now: () => 1_000,
      random: () => 0,
      sleep,
      classify,
      emit,
      async runAttempt() {
        attempts += 1;
        if (attempts === 1) throw new Error('429');
        return 'ok';
      },
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(750);
    expect(emit).toHaveBeenCalledWith({
      provider: 'claude',
      attempt: 1,
      maxRetries: 3,
      statusCode: 429,
      delayMs: 750,
      source: 'exponential_backoff',
    });
  });

  it('honors retryAfterMs instead of the computed backoff', async () => {
    const sleep = vi.fn(async () => {});
    const emit = vi.fn();

    await expect(retryWithBackoff({
      provider: 'codex',
      wallClockDeadline: 20_000,
      now: () => 1_000,
      random: () => 0.99,
      sleep,
      classify: () => ({ statusCode: 503, retryAfterMs: 5_000, reason: 'status_503' }),
      emit,
      async runAttempt() {
        throw new Error('503');
      },
    })).rejects.toThrow('503');

    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(emit).toHaveBeenCalledWith({
      provider: 'codex',
      attempt: 1,
      maxRetries: 3,
      statusCode: 503,
      delayMs: 5_000,
      source: 'retry_after',
    });
  });

  it('stops retrying when the remaining deadline cannot fit the next delay', async () => {
    const sleep = vi.fn(async () => {});
    const error = new Error('429');

    await expect(retryWithBackoff({
      provider: 'claude',
      wallClockDeadline: 1_600,
      now: () => 1_000,
      random: () => 0,
      sleep,
      classify: () => ({ statusCode: 429, retryAfterMs: null, reason: 'status_429' }),
      emit: () => {},
      async runAttempt() {
        throw error;
      },
    })).rejects.toBe(error);

    expect(sleep).not.toHaveBeenCalled();
  });

  it('caps retries at MAX_RETRIES after the initial failed attempt', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;

    await expect(retryWithBackoff({
      provider: 'claude',
      wallClockDeadline: 30_000,
      now: () => 1_000,
      random: () => 0.5,
      sleep,
      classify: () => ({ statusCode: 429, retryAfterMs: null, reason: 'status_429' }),
      emit: () => {},
      async runAttempt() {
        attempts += 1;
        throw new Error(`retry-${attempts}`);
      },
    })).rejects.toThrow('retry-4');

    expect(MAX_RETRIES).toBe(3);
    expect(BASE_BACKOFF_MS).toEqual([1000, 2000, 4000]);
    expect(attempts).toBe(4);
  });
});

describe('sleepWithAbort', () => {
  it('rejects promptly when aborted while sleeping', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const sleeping = sleepWithAbort(5_000, ac.signal);
    ac.abort();
    await expect(sleeping).rejects.toThrow('aborted');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/providers/retry-with-backoff.test.ts`
Expected: FAIL with `Cannot find module '../../packages/core/src/providers/retry-with-backoff.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
export type RetryableProvider = 'claude' | 'codex';

export interface RetryClassification {
  statusCode: 429 | 503;
  retryAfterMs: number | null;
  reason: 'status_429' | 'status_503';
}

export interface ProviderRetryEvent {
  provider: RetryableProvider;
  attempt: number;
  maxRetries: 3;
  statusCode: 429 | 503;
  delayMs: number;
  source: 'retry_after' | 'exponential_backoff';
}

export interface RetryWithBackoffArgs<T> {
  provider: RetryableProvider;
  wallClockDeadline: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  classify: (error: unknown) => RetryClassification | null;
  emit: (event: ProviderRetryEvent) => void;
  runAttempt: () => Promise<T>;
}

export const MAX_RETRIES = 3 as const;
export const BASE_BACKOFF_MS = [1000, 2000, 4000] as const;

export async function retryWithBackoff<T>(args: RetryWithBackoffArgs<T>): Promise<T> {
  const now = args.now ?? (() => Date.now());
  const random = args.random ?? (() => Math.random());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await args.runAttempt();
    } catch (error) {
      const classification = args.classify(error);
      if (!classification) throw error;

      const retryAttempt = attemptIndex + 1;
      if (retryAttempt > MAX_RETRIES) throw error;

      const baseDelayMs = BASE_BACKOFF_MS[retryAttempt - 1]!;
      const exponentialDelayMs = Math.round(baseDelayMs * (0.75 + random() * 0.5));
      const delayMs = classification.retryAfterMs ?? exponentialDelayMs;
      const remainingMs = args.wallClockDeadline - now();

      if (remainingMs <= 0 || delayMs > remainingMs) throw error;

      args.emit({
        provider: args.provider,
        attempt: retryAttempt,
        maxRetries: MAX_RETRIES,
        statusCode: classification.statusCode,
        delayMs,
        source: classification.retryAfterMs == null ? 'exponential_backoff' : 'retry_after',
      });

      await sleep(delayMs);
    }
  }
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('aborted'));
    };

    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/providers/retry-with-backoff.test.ts`
Expected: PASS

### Task I-2: Provider Retry Classifiers (AC-1.1, AC-1.2, AC-4.1, AC-5.1, AC-5.2, AC-5.3)

**Files:**
- Create: `packages/core/src/providers/provider-retry-classifiers.ts`
- Test: `tests/providers/provider-retry-classifiers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyClaudeRetryError,
  classifyCodexRetryError,
  parseRetryAfterHeader,
} from '../../packages/core/src/providers/provider-retry-classifiers.js';

describe('parseRetryAfterHeader', () => {
  it('parses delta-seconds Retry-After values', () => {
    expect(parseRetryAfterHeader('3', () => 1_000)).toBe(3_000);
  });

  it('parses HTTP-date Retry-After values', () => {
    expect(parseRetryAfterHeader('Thu, 01 Jan 1970 00:00:05 GMT', () => 1_000)).toBe(4_000);
  });

  it('ignores malformed and negative Retry-After values', () => {
    expect(parseRetryAfterHeader('-5', () => 1_000)).toBeNull();
    expect(parseRetryAfterHeader('nope', () => 1_000)).toBeNull();
  });
});

describe('classifyClaudeRetryError', () => {
  it('classifies status 429 and reads Retry-After from response headers', () => {
    expect(classifyClaudeRetryError({
      status: 429,
      response: { headers: { 'retry-after': '2' } },
    }, () => 1_000)).toEqual({
      statusCode: 429,
      retryAfterMs: 2_000,
      reason: 'status_429',
    });
  });

  it('returns null for non-retryable 400/401/403 statuses', () => {
    expect(classifyClaudeRetryError({ statusCode: 400 })).toBeNull();
    expect(classifyClaudeRetryError({ statusCode: 401 })).toBeNull();
    expect(classifyClaudeRetryError({ statusCode: 403 })).toBeNull();
  });
});

describe('classifyCodexRetryError', () => {
  it('classifies an explicit status-bearing 503 error', () => {
    expect(classifyCodexRetryError({
      statusCode: 503,
      headers: { 'Retry-After': '4' },
      message: 'service unavailable',
    }, () => 1_000)).toEqual({
      statusCode: 503,
      retryAfterMs: 4_000,
      reason: 'status_503',
    });
  });

  it('classifies an unambiguous rate-limit message fallback', () => {
    expect(classifyCodexRetryError({
      message: 'OpenAI API error: 429 Too Many Requests',
    })).toEqual({
      statusCode: 429,
      retryAfterMs: null,
      reason: 'status_429',
    });
  });

  it('rejects ambiguous message-only failures', () => {
    expect(classifyCodexRetryError({
      message: 'upstream request failed, please retry later',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/providers/provider-retry-classifiers.test.ts`
Expected: FAIL with `Cannot find module '../../packages/core/src/providers/provider-retry-classifiers.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { RetryClassification } from './retry-with-backoff.js';

type HeaderBag = Record<string, unknown> | { get?: (name: string) => string | null } | null | undefined;

export function parseRetryAfterHeader(value: unknown, now: () => number = () => Date.now()): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const delayMs = parsed - now();
  return delayMs < 0 ? null : delayMs;
}

export function classifyClaudeRetryError(error: unknown, now: () => number = () => Date.now()): RetryClassification | null {
  const statusCode = extractStatusCode(error);
  if (statusCode !== 429 && statusCode !== 503) return null;
  return {
    statusCode,
    retryAfterMs: parseRetryAfterHeader(extractRetryAfterHeader(error), now),
    reason: statusCode === 429 ? 'status_429' : 'status_503',
  };
}

export function classifyCodexRetryError(error: unknown, now: () => number = () => Date.now()): RetryClassification | null {
  const explicitStatus = extractStatusCode(error);
  if (explicitStatus === 429 || explicitStatus === 503) {
    return {
      statusCode: explicitStatus,
      retryAfterMs: parseRetryAfterHeader(extractRetryAfterHeader(error), now),
      reason: explicitStatus === 429 ? 'status_429' : 'status_503',
    };
  }

  const message = extractMessage(error);
  if (/\b429\b/.test(message) && /(too many requests|rate limit)/i.test(message)) {
    return { statusCode: 429, retryAfterMs: null, reason: 'status_429' };
  }
  if (/\b503\b/.test(message) && /(service unavailable|overloaded|temporarily unavailable)/i.test(message)) {
    return { statusCode: 503, retryAfterMs: null, reason: 'status_503' };
  }

  return null;
}

function extractStatusCode(error: unknown): 429 | 503 | null {
  const candidates = [
    readPath(error, ['status']),
    readPath(error, ['statusCode']),
    readPath(error, ['response', 'status']),
    readPath(error, ['cause', 'status']),
  ];
  for (const candidate of candidates) {
    if (candidate === 429 || candidate === 503) return candidate;
  }
  return null;
}

function extractRetryAfterHeader(error: unknown): unknown {
  const headerContainers: HeaderBag[] = [
    readPath(error, ['headers']) as HeaderBag,
    readPath(error, ['response', 'headers']) as HeaderBag,
    readPath(error, ['cause', 'headers']) as HeaderBag,
  ];
  for (const headers of headerContainers) {
    const value = headerValue(headers, 'retry-after');
    if (value != null) return value;
  }
  return null;
}

function extractMessage(error: unknown): string {
  const value = readPath(error, ['message']);
  return typeof value === 'string' ? value : '';
}

function headerValue(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  if (typeof headers === 'object' && typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (n: string) => string | null }).get(name);
    return typeof value === 'string' ? value : null;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value;
    }
  }
  return null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value as Record<string, unknown> | undefined;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
    current = current[segment] as Record<string, unknown>;
  }
  return current as unknown;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/providers/provider-retry-classifiers.test.ts`
Expected: PASS

**Track I Verification**

Run: `pnpm vitest run tests/providers/retry-with-backoff.test.ts tests/providers/provider-retry-classifiers.test.ts`
Expected: PASS

## Track II — Observability Contract

### Task II-1: Provider Retry Event Schema (AC-6.1)

**Files:**
- Modify: `packages/core/src/events/plain-log-entry.ts`
- Modify: `tests/events/provider-event-mapping.test.ts`
- Modify: `tests/contract/goldens/observability/event-manifest.json`
- Test: `tests/contract/observability/event-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mapProviderEventToPlainEntry, PROVIDER_EVENT_NAMES, PlainLogEntrySchema } from '../../packages/core/src/events/plain-log-entry.js';

describe('mapProviderEventToPlainEntry', () => {
  it('produces valid entries for all 23 provider event names after adding retry events', () => {
    expect(PROVIDER_EVENT_NAMES).toHaveLength(23);
    for (const name of PROVIDER_EVENT_NAMES) {
      const provider = name.startsWith('claude') ? 'claude' as const : 'codex' as const;
      const entry = mapProviderEventToPlainEntry(provider, name, { turn: 1 });
      expect(() => PlainLogEntrySchema.parse(entry)).not.toThrow();
      expect(entry.fields.provider).toBe(provider);
      expect(entry.fields.event).toBe(name);
    }
  });

  it('JSON-stringifies object-valued fields with _json suffix', () => {
    const entry = mapProviderEventToPlainEntry('claude', 'claude_tool_call', { turn: 1, tool: 'Read', input: { file: '/a' } });
    expect(entry.fields.input_json).toBe('{"file":"/a"}');
    expect(entry.fields.input).toBeUndefined();
  });

  it('preserves primitive fields as-is', () => {
    const entry = mapProviderEventToPlainEntry('codex', 'codex_retry_scheduled', { attempt: 2, delayMs: 1500, source: 'retry_after' });
    expect(entry.fields.attempt).toBe(2);
    expect(entry.fields.delayMs).toBe(1500);
    expect(entry.fields.source).toBe('retry_after');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/events/provider-event-mapping.test.ts tests/contract/observability/event-manifest.test.ts`
Expected: FAIL because `PROVIDER_EVENT_NAMES` length is `21` and the manifest is missing retry event names

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/events/plain-log-entry.ts
import { z } from 'zod';

export const PlainLogKindEnum = z.enum([
  'server_started','server_stopped',
  'batch_created','request_received','request_spilled',
  'batch_completed','batch_failed',
  'project_evicted',
  'stall_watchdog_armed','stall_watchdog_fired',
  'provider_event',
  'server_error',
]);

const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const PlainLogEntrySchema = z.object({
  ts: z.string().datetime({ offset: true }),
  kind: PlainLogKindEnum,
  fields: z.record(z.string(), FieldValue),
}).strict();
export type PlainLogEntry = z.infer<typeof PlainLogEntrySchema>;

export const PROVIDER_EVENT_NAMES = [
  // Claude (9 total: 8 existing + 1 new retry event)
  'claude_session_starting','claude_turn_started','claude_error',
  'claude_turn_completed','claude_text_emission','claude_tool_call','claude_session_closed',
  'claude_compaction','claude_retry_scheduled',
  // Codex (14 total: 13 existing + 1 new retry event)
  'codex_subprocess_starting','codex_spawn_failed','codex_subprocess_started','codex_subprocess_exited',
  'codex_thread_started','codex_turn_started','codex_command_started','codex_command_completed',
  'codex_turn_completed','codex_turn_failed','codex_error','codex_agent_message','codex_file_change',
  'codex_retry_scheduled',
] as const;
export type ProviderEventName = (typeof PROVIDER_EVENT_NAMES)[number];

export function mapProviderEventToPlainEntry(
  provider: 'claude' | 'codex',
  event: ProviderEventName,
  rawFields: Record<string, unknown>,
): PlainLogEntry {
  const fields: Record<string, string | number | boolean | null> = { provider, event };
  for (const [k, v] of Object.entries(rawFields)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[k] = v;
    } else {
      fields[`${k}_json`] = JSON.stringify(v);
    }
  }
  return { ts: new Date().toISOString(), kind: 'provider_event', fields };
}
```

```json
{
  "schemaVersion": 2,
  "kinds": [
    { "kind": "server_started", "provider_events": [] },
    { "kind": "server_stopped", "provider_events": [] },
    { "kind": "batch_created", "provider_events": [] },
    { "kind": "request_received", "provider_events": [] },
    { "kind": "request_spilled", "provider_events": [] },
    { "kind": "batch_completed", "provider_events": [] },
    { "kind": "batch_failed", "provider_events": [] },
    { "kind": "project_evicted", "provider_events": [] },
    { "kind": "stall_watchdog_armed", "provider_events": [] },
    { "kind": "stall_watchdog_fired", "provider_events": [] },
    {
      "kind": "provider_event",
      "provider_events": [
        "claude_session_starting",
        "claude_turn_started",
        "claude_error",
        "claude_turn_completed",
        "claude_text_emission",
        "claude_tool_call",
        "claude_session_closed",
        "claude_compaction",
        "claude_retry_scheduled",
        "codex_subprocess_starting",
        "codex_spawn_failed",
        "codex_subprocess_started",
        "codex_subprocess_exited",
        "codex_thread_started",
        "codex_turn_started",
        "codex_command_started",
        "codex_command_completed",
        "codex_turn_completed",
        "codex_turn_failed",
        "codex_error",
        "codex_agent_message",
        "codex_file_change",
        "codex_retry_scheduled"
      ]
    },
    { "kind": "server_error", "provider_events": [] }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/events/provider-event-mapping.test.ts tests/contract/observability/event-manifest.test.ts`
Expected: PASS

## Track III — Provider Session Integration

### Task III-1: Claude Session Retry Integration (AC-1.1, AC-1.2, AC-5.1, AC-6.1, AC-7.1, AC-8.1)

**Files:**
- Modify: `packages/core/src/providers/claude-session.ts`
- Test: `tests/providers/claude-session-retry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSession } from '../../packages/core/src/providers/claude-session.js';

const busEntries: any[] = [];
let queryAttempt = 0;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: any) => {
    queryAttempt += 1;
    return {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (emitted) return { value: undefined, done: true };
            emitted = true;
            // First attempt: throw 429 with Retry-After header
            if (queryAttempt === 1) {
              const err = Object.assign(new Error('rate limited'), {
                status: 429,
                response: { headers: { 'retry-after': '1' } },
              });
              throw err;
            }
            // Second attempt: succeed
            return { value: { type: 'result', subtype: 'success', result: 'ok', session_id: 'claude-session', usage: { input_tokens: 10, output_tokens: 5 } }, done: false };
          },
        };
      },
      close() {},
    };
  }),
}));

describe('ClaudeSession retry integration', () => {
  beforeEach(() => {
    busEntries.length = 0;
    queryAttempt = 0;
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries a 429 once, emits claude_retry_scheduled, and returns the successful later turn', async () => {
    const bus = { emitPlainEntry(entry: unknown) { busEntries.push(entry); } };
    
    const session = new ClaudeSession({
      model: 'claude-test',
      opts: {
        cwd: '/tmp/project',
        wallClockDeadline: Date.now() + 10_000,
        abortSignal: new AbortController().signal,
        bus,
        taskId: 'task-1',
        taskIndex: 0,
      } as any,
    });

    const pending = session.send('retry me');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.terminationReason).toBe('ok');
    expect(queryAttempt).toBe(2);
    expect(busEntries.some((entry) => (entry as any).fields?.event === 'claude_retry_scheduled')).toBe(true);
  });

  it('fails fast on a 400 without sleeping or retrying', async () => {
    vi.mocked((await import('@anthropic-ai/claude-agent-sdk')).query).mockImplementationOnce(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw Object.assign(new Error('bad request'), { statusCode: 400 });
          },
        };
      },
      close() {},
    }));

    const session = new ClaudeSession({
      model: 'claude-test',
      opts: {
        cwd: '/tmp/project',
        wallClockDeadline: Date.now() + 10_000,
        abortSignal: new AbortController().signal,
      } as any,
    });

    queryAttempt = 0;
    await expect(session.send('bad request')).rejects.toThrow('bad request');
    expect(queryAttempt).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/providers/claude-session-retry.test.ts`
Expected: FAIL because `ClaudeSession.send()` only attempts one SDK query and emits no `claude_retry_scheduled` event

- [ ] **Step 3: Write minimal implementation**

Update the import block in `packages/core/src/providers/claude-session.ts` to add two new imports after the existing confinement import (line 27):

```ts
import { buildConfinementHook } from './claude-cwd-confinement.js';
// ADD THESE TWO NEW IMPORTS:
import { classifyClaudeRetryError } from './provider-retry-classifiers.js';
import { retryWithBackoff, sleepWithAbort } from './retry-with-backoff.js';
```

(Keep the existing `session-helpers.js` import at line 28 unchanged.)

Replace the `send()` method in `packages/core/src/providers/claude-session.ts` with this complete version:

```ts
async send(instruction: string, _opts?: TurnOpts): Promise<TurnResult> {
  if (this.closed) throw new Error('claude-session: send() on closed session');
  const startMs = Date.now();
  this.turns += 1;
  const turnIndex = this.turns;
  this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_turn_started', {
    turn: turnIndex,
    resume: Boolean(this.sessionId),
    ...(this.sessionId && { sessionId: this.sessionId }),
    ...this.taskTag(),
  }));

  async function* promptIterable(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: instruction },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  const skillBundle = this.args.opts.skills;
  if (skillBundle && !this.skillPluginReady) {
    await writeClaudePluginWrapper(skillBundle.stagedRoot, skillBundle.names);
    this.skillPluginReady = true;
  }
  const skillOptions = skillBundle ? buildClaudeSkillOptions(skillBundle.stagedRoot, skillBundle.names) : {};

  const hookMap: Record<string, unknown> = {};
  if (_opts?.goalCondition) {
    const condition = _opts.goalCondition;
    hookMap.Stop = [{
      hooks: [async (input: { stop_hook_active?: boolean }) => {
        if (input.stop_hook_active) return {};
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'Stop',
            decision: 'block',
            reason: `Goal not yet met. Continue working toward: ${condition}`,
          },
        };
      }],
    }];
  }
  if (this.args.opts.sandboxPolicy && this.args.opts.cwd) {
    Object.assign(hookMap, buildConfinementHook(this.args.opts.sandboxPolicy, this.args.opts.cwd));
  }
  const goalHooks: Record<string, unknown> = Object.keys(hookMap).length ? { hooks: hookMap } : {};

  const events = await retryWithBackoff<SDKMessage[]>({
    provider: 'claude',
    wallClockDeadline: this.args.opts.wallClockDeadline,
    sleep: (ms) => sleepWithAbort(ms, this.args.opts.abortSignal),
    classify: (error) => classifyClaudeRetryError(error),
    emit: (event) => {
      this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_retry_scheduled', {
        ...event,
        ...this.taskTag(),
      }));
    },
    runAttempt: async () => {
      const q = query({
        prompt: promptIterable(),
        options: {
          model: this.args.model,
          permissionMode: 'bypassPermissions',
          cwd: this.args.opts.cwd,
          abortSignal: this.args.opts.abortSignal,
          env: {
            ...process.env,
            ...(this.args.apiKey && { ANTHROPIC_API_KEY: this.args.apiKey }),
            ...(this.args.baseUrl && { ANTHROPIC_BASE_URL: this.args.baseUrl }),
            ...(this.args.oauthAccessToken && { ANTHROPIC_AUTH_TOKEN: this.args.oauthAccessToken }),
          },
          ...skillOptions,
          ...(this.sessionId && { resume: this.sessionId }),
          ...goalHooks,
          ...(this.args.opts.disallowedTools?.length && { disallowedTools: this.args.opts.disallowedTools }),
        } as Parameters<typeof query>[0]['options'],
      });
      this.activeQuery = q as unknown as { close?: () => unknown };

      const attemptEvents: SDKMessage[] = [];
      try {
        for await (const ev of q) {
          attemptEvents.push(ev);
          if (!this.sessionId) {
            const sid = (ev as { session_id?: unknown }).session_id;
            if (typeof sid === 'string' && sid.length > 0) this.sessionId = sid;
          }
          this.emitEventTelemetry(ev);
          if ((ev as { type?: string }).type === 'result') break;
        }
      } catch (err) {
        const e = err as { name?: string; message?: string };
        this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_error', {
          name: e.name ?? 'unknown',
          message: e.message ?? String(err),
          ...this.taskTag(),
        }));
        try { q.close(); } catch {}
        this.activeQuery = undefined;
        throw err;
      }

      try { q.close(); } catch {}
      this.activeQuery = undefined;
      return attemptEvents;
    },
  });

  const rateCard = resolveRateCard(this.args.model);
  const norm = normalizeClaudeTurn(events, {
    durationMs: Date.now() - startMs,
    costUSD: 0,
    model: this.args.model,
  });
  norm.costUSD = rateCard ? priceTokens(norm.usage, rateCard) : 0;

  this.bus?.emitPlainEntry(mapProviderEventToPlainEntry('claude', 'claude_turn_completed', {
    turn: turnIndex,
    inputTokens: norm.usage.inputTokens,
    outputTokens: norm.usage.outputTokens,
    cachedReadTokens: norm.usage.cachedReadTokens ?? 0,
    cachedNonReadTokens: norm.usage.cachedNonReadTokens ?? 0,
    terminationReason: norm.terminationReason,
    filesWritten: norm.filesWritten.length,
    ...(norm.errorCode && { errorCode: norm.errorCode }),
    ...this.taskTag(),
  }));

  return norm;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/providers/claude-session-retry.test.ts tests/providers/claude-session-isolation.test.ts`
Expected: PASS

### Task III-2: Codex Session Retry Integration (AC-1.1, AC-1.2, AC-3.1, AC-5.1, AC-5.2, AC-5.3, AC-6.1, AC-7.1, AC-8.1)

**Files:**
- Modify: `packages/core/src/providers/codex-cli-session.ts`
- Test: `tests/providers/codex-cli-session-retry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexCliSession } from '../../packages/core/src/providers/codex-cli-session.js';

const spawnMock = vi.fn();

vi.mock('cross-spawn', () => ({
  default: spawnMock,
}));

vi.mock('../../packages/core/src/providers/codex-cli-launch.js', () => ({
  buildCodexCliLaunch: () => ({ command: 'codex', args: ['exec'], env: {} }),
}));

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  pid = 1234;
  kill() {
    this.killed = true;
    return true;
  }
}

describe('CodexCliSession retry integration', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries a retryable 503 turn_failed subprocess once and then returns the later success result', async () => {
    let attempt = 0;
    spawnMock.mockImplementation(() => {
      const proc = new FakeProc();
      queueMicrotask(() => {
        attempt += 1;
        if (attempt === 1) {
          proc.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'OpenAI API error: 503 Service Unavailable' } }) + '\n');
          proc.exitCode = 1;
        } else {
          proc.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
          proc.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n');
          proc.exitCode = 0;
        }
        proc.emit('exit', proc.exitCode, null);
      });
      return proc as any;
    });

    const session = new CodexCliSession({
      cfg: { model: 'gpt-test' } as any,
      opts: {
        cwd: '/tmp/project',
        wallClockDeadline: Date.now() + 10_000,
        abortSignal: new AbortController().signal,
        bus: { emitPlainEntry() {} },
      } as any,
    });

    const pending = session.send('retry me');
    await vi.advanceTimersByTimeAsync(750);
    const result = await pending;

    expect(result.terminationReason).toBe('ok');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('returns the original non-retryable 401 TurnResult without a second subprocess attempt', async () => {
    spawnMock.mockImplementation(() => {
      const proc = new FakeProc();
      queueMicrotask(() => {
        proc.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'OpenAI API error: 401 Unauthorized' } }) + '\n');
        proc.exitCode = 1;
        proc.emit('exit', 1, null);
      });
      return proc as any;
    });

    const session = new CodexCliSession({
      cfg: { model: 'gpt-test' } as any,
      opts: {
        cwd: '/tmp/project',
        wallClockDeadline: Date.now() + 10_000,
        abortSignal: new AbortController().signal,
      } as any,
    });

    const result = await session.send('no retry');
    expect(result.terminationReason).toBe('error');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/providers/codex-cli-session-retry.test.ts`
Expected: FAIL because `CodexCliSession.send()` only runs one subprocess attempt and never classifies retryable failures

- [ ] **Step 3: Write minimal implementation**

Update the import block in `packages/core/src/providers/codex-cli-session.ts` to add two new imports after the existing codex-skill-home import (line 37):

```ts
import { prepareCodexSkillHome, codexAuthMode } from './codex-skill-home.js';
// ADD THESE TWO NEW IMPORTS:
import { classifyCodexRetryError } from './provider-retry-classifiers.js';
import { retryWithBackoff, sleepWithAbort } from './retry-with-backoff.js';
```

(Keep the existing `session-helpers.js` import at line 45 unchanged.)

Add this helper class near the top of `packages/core/src/providers/codex-cli-session.ts`:

```ts
class CodexAttemptError extends Error {
  constructor(
    message: string,
    readonly turnResult: TurnResult,
    readonly statusCode?: number,
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = 'CodexAttemptError';
  }
}
```

Replace the `send()` method in `packages/core/src/providers/codex-cli-session.ts` with this complete version:

```ts
async send(instruction: string, _turnOpts?: TurnOpts): Promise<TurnResult> {
  if (this.closed) throw new Error('codex-cli-session: send() on closed session');
  const startMs = Date.now();

  const runAttempt = async (): Promise<TurnResult> => {
    if (!this.tempDir) this.tempDir = await mkdtemp(join(tmpdir(), 'mma-codex-'));
    const outputFile = join(this.tempDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

    let codexHome: string | undefined = this.skillHomePath;
    if (this.args.opts.skills && !this.codexSkillHomeReady) {
      this.skillHomePath = await prepareCodexSkillHome({
        stagedRoot: this.args.opts.skills.stagedRoot,
        authMode: codexAuthMode(this.args.cfg),
      });
      this.codexSkillHomeReady = true;
      codexHome = this.skillHomePath;
    }

    const launch = buildCodexCliLaunch({
      cfg: this.args.cfg,
      opts: { cwd: this.args.opts.cwd },
      outputFile,
      ...(this.threadId && { resumeSessionId: this.threadId }),
      ...(codexHome && { codexHome }),
    });

    const bus = busOf(this.args.opts);
    const envelope = envelopeOf(this.args.opts);
    const tag = this.taskTag();
    const tracker = new TurnTracker(this.cumulativeUsage, bus, envelope, tag);

    bus?.emitPlainEntry(mapProviderEventToPlainEntry('codex', 'codex_subprocess_starting', {
      model: this.args.cfg.model,
      cwd: this.args.opts.cwd,
      resume: Boolean(this.threadId),
      ...(this.threadId && { threadId: this.threadId }),
      ...tag,
    }));

    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: this.args.opts.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      bus?.emitPlainEntry(mapProviderEventToPlainEntry('codex', 'codex_spawn_failed', {
        code: e.code ?? 'unknown',
        message: e.message ?? String(err),
        ...tag,
      }));
      return this.finalizeError(tracker, startMs, e.code === 'ENOENT' ? 'codex_not_installed' : 'spawn_failed', e.message ?? String(err));
    }

    bus?.emitPlainEntry(mapProviderEventToPlainEntry('codex', 'codex_subprocess_started', {
      pid: proc.pid ?? -1,
      ...tag,
    }));

    this.activeProc = proc;
    proc.stdin?.write(instruction);
    proc.stdin?.end();

    const cleanupGuards = this.armGuards(proc, tracker);
    const stderrBufRef = { value: '' };
    try {
      await consumeStream(proc, tracker, stderrBufRef);
    } finally {
      cleanupGuards();
      this.activeProc = undefined;
    }

    if (tracker.threadId) this.threadId = tracker.threadId;

    bus?.emitPlainEntry(mapProviderEventToPlainEntry('codex', 'codex_subprocess_exited', {
      exitCode: proc.exitCode,
      turns: tracker.turns,
      terminationReason: tracker.terminationReason,
      ...(tracker.errorCode && { errorCode: tracker.errorCode }),
      ...(stderrBufRef.value && { stderrTail: stderrBufRef.value.slice(-500) }),
      ...(proc.pid !== undefined && { pid: proc.pid }),
      ...tag,
    }));

    const finalMessage = tracker.lastAgentMessage || await readOutputFile(outputFile);
    const turnUsage = tracker.flushUsageDelta();
    const rateCard = resolveRateCard(this.args.cfg.model);
    const costUSD = rateCard ? priceTokens(turnUsage, rateCard) : 0;

    if (tracker.terminationReason === 'ok' && proc.exitCode !== 0 && proc.exitCode !== null) {
      tracker.terminationReason = 'error';
      tracker.errorCode = `exit_${proc.exitCode}`;
      tracker.errorMessage = (stderrBufRef.value || `codex exited ${proc.exitCode}`).slice(0, 2000);
    }

    const result: TurnResult = {
      output: finalMessage,
      usage: turnUsage,
      costUSD,
      turns: tracker.turns,
      durationMs: Date.now() - startMs,
      terminationReason: tracker.terminationReason,
      ...(tracker.errorCode && { errorCode: tracker.errorCode }),
      filesWritten: [...tracker.filesWritten],
      usedShell: tracker.usedShell,
    };

    if (result.terminationReason === 'error') {
      const retryable = classifyCodexRetryError({
        message: tracker.errorMessage ?? result.errorCode ?? 'codex turn failed',
      });
      throw new CodexAttemptError(
        tracker.errorMessage ?? result.errorCode ?? 'codex turn failed',
        result,
        retryable?.statusCode,
        retryable?.retryAfterMs ?? null,
      );
    }

    return result;
  };

  try {
    return await retryWithBackoff({
      provider: 'codex',
      wallClockDeadline: this.args.opts.wallClockDeadline,
      sleep: (ms) => sleepWithAbort(ms, this.args.opts.abortSignal),
      classify: (error) => classifyCodexRetryError(error),
      emit: (event) => {
        busOf(this.args.opts)?.emitPlainEntry(mapProviderEventToPlainEntry('codex', 'codex_retry_scheduled', {
          ...event,
          ...this.taskTag(),
        }));
      },
      runAttempt,
    });
  } catch (error) {
    if (error instanceof CodexAttemptError) return error.turnResult;
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/providers/codex-cli-session-retry.test.ts tests/providers/codex-cli-session.test.ts`
Expected: PASS

**Track III Verification**

Run: `pnpm vitest run tests/providers/claude-session-retry.test.ts tests/providers/claude-session-isolation.test.ts tests/providers/codex-cli-session-retry.test.ts tests/providers/codex-cli-session.test.ts`
Expected: PASS

## Final Verification

Run: `pnpm vitest run tests/providers/retry-with-backoff.test.ts tests/providers/provider-retry-classifiers.test.ts tests/events/provider-event-mapping.test.ts tests/contract/observability/event-manifest.test.ts tests/providers/claude-session-retry.test.ts tests/providers/claude-session-isolation.test.ts tests/providers/codex-cli-session-retry.test.ts tests/providers/codex-cli-session.test.ts`
Expected: PASS

## Acceptance Criteria Mapping

- AC-1.1, AC-1.2: Tasks I-2, III-1, III-2
- AC-2.1, AC-3.1, AC-4.1, AC-7.1: Task I-1
- AC-5.1, AC-5.2, AC-5.3: Tasks I-2, III-1, III-2
- AC-6.1: Tasks II-1, III-1, III-2
- AC-8.1: Tasks III-1, III-2
