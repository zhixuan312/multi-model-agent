# Custom Task Types Via Runtime Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add config-driven custom task type registration so MMA can validate, dispatch, and sync caller-facing custom skills without source forks.

**Architecture:** Keep built-in task types immutable, then build a per-process runtime catalog that merges built-ins with config-defined custom aliases. Reuse the existing built-in Zod request schemas, pipeline, and bundled skill-install flow by introducing two new seams: a contract lookup layer for ingress validation and a descriptor-driven catalog/skill-source layer for runtime lookup. Preserve existing built-in behavior by routing custom execution through the same code paths and falling back to built-ins when `customTypes` is absent or empty.

**Tech Stack:** TypeScript, Node.js 22, Zod, Vitest, pnpm workspaces, ESM imports with `.js` suffixes in source.

## Ground Truth At HEAD

- Built-in task types are still hardcoded in `packages/core/src/unified/type-registry.ts` as `11` names, not `13`.
- `packages/core/src/unified/task-input-schema.ts` is a static `z.discriminatedUnion('type', ...)`; it cannot accept runtime-defined `type` values.
- `packages/core/src/unified/skill-loader.ts` only knows how to read bundled skills from `packages/core/src/skills/<type>/...`.
- `packages/core/src/unified/reviewer-output-parser.ts` and `runTwoPhasePipeline()` are keyed by built-in task contracts, so custom task names should be validated and parsed through their aliased `requestContract` instead of widening every internal route type to arbitrary strings.
- `packages/server/src/http/server.ts` already accepts `configPath?: string`; use that for relative custom-skill resolution instead of inventing a second startup path channel.
- `packages/server/src/cli/sync-skills.ts` does not load config today, and it cannot import discovery helpers directly from `packages/server/src/cli/index.ts` without creating a circular dependency. Shared config discovery must be extracted into a new CLI helper module.
- Existing regression coverage already pins the static built-in paths in `tests/unified/type-registry.test.ts`, `tests/unified/task-input-schema.test.ts`, `tests/cli/sync-skills.test.ts`, and `tests/contract/http/route-contract.test.ts`; new work should add focused files rather than rewiring those large existing test files.

## File Structure

```text
docs/mma/plans/2026-07-06-caller-defined-custom-task-types-via-runtime-registration.md
packages/core/src/config/schema.ts                                   modify
packages/core/src/index.ts                                           modify
packages/core/src/unified/request-contracts.ts                       create
packages/core/src/unified/task-catalog.ts                            create
packages/core/src/unified/task-input-schema.ts                       modify
packages/core/src/unified/skill-loader.ts                            modify
packages/server/src/http/handler-deps.ts                             modify
packages/server/src/http/server.ts                                   modify
packages/server/src/http/handlers/unified-task.ts                    modify
packages/server/src/cli/config-discovery.ts                          create
packages/server/src/cli/index.ts                                     modify
packages/server/src/cli/sync-skills.ts                               modify
packages/server/src/skill-install/installable-skill-sources.ts       create
tests/config/load-config-custom-types.test.ts                        create
tests/unified/request-contracts.test.ts                              create
tests/unified/task-catalog.test.ts                                   create
tests/unified/custom-skill-loader.test.ts                            create
tests/http/custom-task-startup.test.ts                               create
tests/contract/http/custom-task-types.test.ts                        create
tests/cli/installable-skill-sources.test.ts                          create
tests/cli/sync-skills-custom.test.ts                                 create
```

---

## Track I: Catalog And Validation Foundations

### Task I-1: Extend The Config Schema For `customTypes` (AC-1.1)

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Test: `tests/config/load-config-custom-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const minimalAgents = {
  standard: {
    type: 'codex' as const,
    model: 'test-standard',
    baseUrl: 'https://example.test/v1',
  },
  complex: {
    type: 'codex' as const,
    model: 'test-complex',
    baseUrl: 'https://example.test/v1',
  },
};

describe('loadConfigFromFile customTypes schema', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-custom-types-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a config whose customTypes entry has the required fields', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: minimalAgents,
      customTypes: [
        {
          name: 'security-audit',
          requestContract: 'audit',
          defaultTier: 'complex',
          sandbox: 'read-only',
          skillPaths: {
            implement: './skills/security-audit/implement.md',
            review: './skills/security-audit/review.md',
            caller: './skills/mma-security-audit/SKILL.md',
          },
        },
      ],
    }));

    const config = await loadConfigFromFile(configPath);
    expect(config.customTypes).toEqual([
      {
        name: 'security-audit',
        requestContract: 'audit',
        defaultTier: 'complex',
        sandbox: 'read-only',
        skillPaths: {
          implement: './skills/security-audit/implement.md',
          review: './skills/security-audit/review.md',
          caller: './skills/mma-security-audit/SKILL.md',
        },
      },
    ]);
  });

  it('rejects a customTypes entry missing required skillPaths members', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: minimalAgents,
      customTypes: [
        {
          name: 'security-audit',
          requestContract: 'audit',
          defaultTier: 'complex',
          sandbox: 'read-only',
          skillPaths: {
            implement: './skills/security-audit/implement.md',
            review: './skills/security-audit/review.md',
          },
        },
      ],
    }));

    await expect(loadConfigFromFile(configPath)).rejects.toThrow(/customTypes/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/config/load-config-custom-types.test.ts`
Expected: FAIL with a Zod error because `multiModelConfigSchema` does not allow `customTypes`.

- [ ] **Step 3: Write minimal implementation**

Update [packages/core/src/config/schema.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/config/schema.ts) to add custom type support.

First, add the `agentTierSchema` export after the `effortSchema`:

```ts
export const agentTierSchema = z.enum(['standard', 'complex', 'main']);
```

Then add custom type schemas before the `multiModelConfigSchema`:

```ts
const customTypeNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);

const requestContractIdSchema = z.enum([
  'audit',
  'investigate',
  'review',
  'debug',
  'research',
  'journal_recall',
  'journal_record',
  'delegate',
  'execute_plan',
  'retry_tasks',
  'orchestrate',
]);

export type RequestContractId = z.infer<typeof requestContractIdSchema>;

const customSkillPathsSchema = z.object({
  implement: z.string().trim().min(1),
  review: z.string().trim().min(1),
  caller: z.string().trim().min(1),
}).strict();

export const customTypeSchema = z.object({
  name: customTypeNameSchema,
  requestContract: requestContractIdSchema,
  defaultTier: agentTierSchema,
  sandbox: z.enum(['read-only', 'cwd-only']),
  skillPaths: customSkillPathsSchema,
}).strict();

export type CustomTypeConfig = z.infer<typeof customTypeSchema>;
```

Then update the `multiModelConfigSchema`:

```ts
export const multiModelConfigSchema = z.object({
  agents: z.object({
    standard: agentConfigSchema,
    complex: agentConfigSchema,
    main: agentConfigSchema.optional(),
  }),
  defaults: defaultsSchema,
  diagnostics: z.object({
    log: z.boolean().default(false),
    logDir: z.string().min(1).optional(),
  }).optional(),
  server: serverBlockSchema,
  telemetry: z.object({
    enabled: z.boolean(),
  }).optional(),
  research: ResearchConfigSchema,
  customTypes: z.array(customTypeSchema).default([]),
}).strict();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/config/load-config-custom-types.test.ts`
Expected: PASS

### Task I-2: Extract Reusable Request Contracts And Dynamic Validation (AC-2.2, AC-2.5)

**Files:**
- Create: `packages/core/src/unified/request-contracts.ts`
- Modify: `packages/core/src/unified/task-input-schema.ts`
- Test: `tests/unified/request-contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  REQUEST_CONTRACT_SCHEMAS,
  buildBuiltInTaskInputSchema,
  validateTaskInput,
  type TaskValidationCatalog,
  type RequestContractId,
} from '../../packages/core/src/unified/request-contracts.js';

function makeCatalog(): TaskValidationCatalog {
  const contractEntries = Object.entries(REQUEST_CONTRACT_SCHEMAS) as [RequestContractId, any][];
  return {
    byName: new Map([
      ['review', { name: 'review', requestContract: 'review' as RequestContractId }],
      ['security-audit', { name: 'security-audit', requestContract: 'audit' as RequestContractId }],
    ]),
    requestContracts: new Map(contractEntries),
  };
}

describe('request-contracts', () => {
  it('buildBuiltInTaskInputSchema still accepts the built-in delegate shape', () => {
    const schema = buildBuiltInTaskInputSchema();
    expect(schema.safeParse({ type: 'delegate', prompt: 'do work' }).success).toBe(true);
  });

  it('validateTaskInput preserves a custom type name while validating against the aliased contract', () => {
    const parsed = validateTaskInput(
      { type: 'security-audit', target: { paths: ['/tmp/spec.md'] } },
      makeCatalog(),
    );

    expect(parsed.type).toBe('security-audit');
    expect(parsed.target).toEqual({ paths: ['/tmp/spec.md'] });
  });

  it('validateTaskInput rejects an unknown runtime type with unknown_task_type details', () => {
    expect(() => validateTaskInput({ type: 'bogus', prompt: 'x' }, makeCatalog())).toThrow(
      /unknown_task_type/,
    );
  });

  it('validateTaskInput rejects a custom alias when the aliased built-in contract would reject it', () => {
    expect(() => validateTaskInput({ type: 'security-audit' }, makeCatalog())).toThrow(
      /Validation failed/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unified/request-contracts.test.ts`
Expected: FAIL with module-not-found errors for `request-contracts.ts`.

- [ ] **Step 3: Write minimal implementation**

Create [packages/core/src/unified/request-contracts.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/unified/request-contracts.ts) with:

```ts
import { z } from 'zod';
import type { RequestContractId } from '../config/schema.js';

// Re-export for convenience
export type { RequestContractId } from '../config/schema.js';

const reviewPolicySchema = z.enum(['reviewed', 'none']);
const sessionIdsSchema = z.object({
  implementer: z.string().optional(),
  reviewer: z.string().optional(),
}).optional();

const agentTierSchema = z.enum(['standard', 'complex', 'main']);

const targetSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).optional(),
  inline: z.string().min(1).optional(),
}).refine(
  (t) => {
    const hasPaths = t.paths !== undefined && t.paths.length > 0;
    const hasInline = t.inline !== undefined;
    return !(hasPaths && hasInline);
  },
  { message: 'target must have paths or inline, not both' },
);

const commonFields = {
  agentTier: agentTierSchema.optional(),
  reviewPolicy: reviewPolicySchema.optional(),
  sessionIds: sessionIdsSchema,
  contextBlockIds: z.array(z.string()).optional(),
};

export const REQUEST_CONTRACT_SCHEMAS = {
  audit: z.object({
    type: z.string().min(1),
    subtype: z.enum(['default', 'plan', 'spec', 'skill']).optional(),
    prompt: z.string().optional(),
    target: targetSchema,
    ...commonFields,
  }).strict(),
  investigate: z.object({
    type: z.string().min(1),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...commonFields,
  }).strict(),
  review: z.object({
    type: z.string().min(1),
    prompt: z.string().optional(),
    target: targetSchema,
    ...commonFields,
  }).strict(),
  debug: z.object({
    type: z.string().min(1),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...commonFields,
  }).strict(),
  research: z.object({
    type: z.string().min(1),
    prompt: z.string().min(20),
    ...commonFields,
  }).strict(),
  journal_recall: z.object({
    type: z.string().min(1),
    prompt: z.string().min(10),
    ...commonFields,
  }).strict(),
  delegate: z.object({
    type: z.string().min(1),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    done: z.string().optional(),
    ...commonFields,
  }).strict(),
  execute_plan: z.object({
    type: z.string().min(1),
    prompt: z.string().optional(),
    target: z.object({ paths: z.array(z.string().min(1)).length(1) }),
    tasks: z.array(z.string()).default([]),
    ...commonFields,
  }).strict(),
  journal_record: z.object({
    type: z.string().min(1),
    prompt: z.string().min(1),
    ...commonFields,
  }).strict(),
  retry_tasks: z.object({
    type: z.string().min(1),
    taskId: z.string().uuid(),
    taskIndices: z.array(z.number().int().nonnegative()).min(1),
    ...commonFields,
  }).strict(),
  orchestrate: z.object({
    type: z.string().min(1),
    prompt: z.string().min(1),
    outputFormat: z.string().optional(),
    ...commonFields,
  }).strict(),
} satisfies Record<RequestContractId, z.ZodTypeAny>;

export const taskEnvelopeSchema = z.object({
  type: z.string().min(1),
}).passthrough();

export interface TaskValidationCatalog {
  byName: Map<string, { name: string; requestContract: RequestContractId }>;
  requestContracts: Map<RequestContractId, z.ZodTypeAny>;
}

export function buildBuiltInTaskInputSchema(): z.ZodTypeAny {
  return z.discriminatedUnion('type', [
    REQUEST_CONTRACT_SCHEMAS.audit.extend({ type: z.literal('audit') }),
    REQUEST_CONTRACT_SCHEMAS.investigate.extend({ type: z.literal('investigate') }),
    REQUEST_CONTRACT_SCHEMAS.review.extend({ type: z.literal('review') }),
    REQUEST_CONTRACT_SCHEMAS.debug.extend({ type: z.literal('debug') }),
    REQUEST_CONTRACT_SCHEMAS.research.extend({ type: z.literal('research') }),
    REQUEST_CONTRACT_SCHEMAS.journal_recall.extend({ type: z.literal('journal_recall') }),
    REQUEST_CONTRACT_SCHEMAS.delegate.extend({ type: z.literal('delegate') }),
    REQUEST_CONTRACT_SCHEMAS.execute_plan.extend({ type: z.literal('execute_plan') }),
    REQUEST_CONTRACT_SCHEMAS.journal_record.extend({ type: z.literal('journal_record') }),
    REQUEST_CONTRACT_SCHEMAS.retry_tasks.extend({ type: z.literal('retry_tasks') }),
    REQUEST_CONTRACT_SCHEMAS.orchestrate.extend({ type: z.literal('orchestrate') }),
  ]);
}

export function validateTaskInput(raw: unknown, catalog: TaskValidationCatalog): Record<string, unknown> {
  const envelope = taskEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`Validation failed: ${envelope.error.message}`);
  }

  const descriptor = catalog.byName.get(envelope.data.type);
  if (!descriptor) {
    throw new Error(`unknown_task_type:${envelope.data.type}`);
  }

  const contract = catalog.requestContracts.get(descriptor.requestContract);
  if (!contract) {
    throw new Error(`unknown_request_contract:${descriptor.requestContract}`);
  }

  const parsed = contract.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Validation failed: ${parsed.error.message}`);
  }

  return parsed.data as Record<string, unknown>;
}
```

Replace [packages/core/src/unified/task-input-schema.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/unified/task-input-schema.ts) with:

```ts
import { buildBuiltInTaskInputSchema } from './request-contracts.js';

export const taskInputSchema = buildBuiltInTaskInputSchema();

export type TaskInput = typeof taskInputSchema['_output'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unified/request-contracts.test.ts`
Expected: PASS

### Task I-3: Build The Runtime Task Catalog (AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-2.1, AC-3.4)

**Files:**
- Create: `packages/core/src/unified/task-catalog.ts`
- Modify: `packages/core/src/index.ts`
- Test: `tests/unified/task-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildTaskCatalog,
  type RuntimeCustomTypeConfig,
} from '../../packages/core/src/unified/task-catalog.js';

function writeSkill(dir: string, rel: string, body: string): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe('buildTaskCatalog', () => {
  it('resolves a valid custom type into the runtime catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-catalog-'));
    const configPath = path.join(root, 'config.json');
    writeSkill(root, 'skills/security-audit/implement.md', 'Implementer prompt');
    writeSkill(root, 'skills/security-audit/review.md', 'Refiner prompt');
    writeSkill(root, 'skills/mma-security-audit/SKILL.md', 'Caller skill');

    const customTypes: RuntimeCustomTypeConfig[] = [
      {
        name: 'security-audit',
        requestContract: 'audit',
        defaultTier: 'complex',
        sandbox: 'read-only',
        skillPaths: {
          implement: './skills/security-audit/implement.md',
          review: './skills/security-audit/review.md',
          caller: './skills/mma-security-audit/SKILL.md',
        },
      },
    ];

    const catalog = buildTaskCatalog(customTypes, configPath, ['mma-audit']);
    expect(catalog.byName.get('security-audit')?.kind).toBe('custom');
    expect(catalog.byName.get('security-audit')?.requestContract).toBe('audit');
    expect(catalog.byName.get('security-audit')?.worktree).toBe(false);
  });

  it('rejects collisions with built-in task names', () => {
    expect(() => buildTaskCatalog([
      {
        name: 'audit',
        requestContract: 'audit',
        defaultTier: 'complex',
        sandbox: 'read-only',
        skillPaths: { implement: '/x', review: '/y', caller: '/z' },
      },
    ], '/tmp/config.json', ['mma-audit'])).toThrow(/custom_type_name_collision/);
  });

  it('rejects duplicate custom names and reports the offending type', () => {
    const duplicate = {
      name: 'security-audit',
      requestContract: 'audit' as const,
      defaultTier: 'complex' as const,
      sandbox: 'read-only' as const,
      skillPaths: { implement: '/x', review: '/y', caller: '/z' },
    };

    expect(() => buildTaskCatalog([duplicate, duplicate], '/tmp/config.json', ['mma-audit'])).toThrow(
      /custom_type_duplicate/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unified/task-catalog.test.ts`
Expected: FAIL with module-not-found errors for `task-catalog.ts`.

- [ ] **Step 3: Write minimal implementation**

Create [packages/core/src/unified/task-catalog.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/unified/task-catalog.ts). This module merges the immutable built-in types from `type-registry.ts` with custom types from config into a single runtime catalog. No separate `BUILTIN_TASK_TYPES` module is needed; we reuse `TASK_TYPES` and `TYPE_REGISTRY` directly as the immutable baseline:

```ts

```ts
import fs from 'node:fs';
import path from 'node:path';
import { TASK_TYPES, TYPE_REGISTRY, type TaskType, oppositeAgent } from './type-registry.js';
import { REQUEST_CONTRACT_SCHEMAS, type TaskValidationCatalog } from './request-contracts.js';
import type { CustomTypeConfig, RequestContractId } from '../config/schema.js';

export type RuntimeCustomTypeConfig = CustomTypeConfig;

export interface ResolvedTypeConfig {
  name: string;
  kind: 'builtin' | 'custom';
  requestContract: RequestContractId;
  defaultTier: 'standard' | 'complex' | 'main';
  sandbox: 'read-only' | 'cwd-only';
  worktree: boolean;
  reviewerTier: 'standard' | 'complex' | 'main';
  targetAcceptance: {
    paths: boolean;
    inline: boolean;
    required: boolean;
  };
  /** For custom types: absolute paths to implement/review files. For built-ins: null (bundled loader handles them). */
  coreSkills: {
    implementPath: string;
    reviewPath: string;
  } | null;
  /** For custom types: absolute path to caller-facing skill file. For built-ins: null. */
  callerSkillPath: string | null;
}

export interface ResolvedTaskCatalog extends TaskValidationCatalog {
  types: string[];
}

function fail(code: string, typeName: string, field: string, reason: string): never {
  throw new Error(`${code}: type=${typeName} field=${field} reason=${reason}`);
}

function resolveSkillPath(configPath: string, rawPath: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(configPath), rawPath);
}

export function buildTaskCatalog(
  customTypes: RuntimeCustomTypeConfig[],
  configPath: string,
  builtinCallerSkillNames: readonly string[],
): ResolvedTaskCatalog {
  const byName = new Map<string, ResolvedTypeConfig>();
  const requestContracts = new Map(Object.entries(REQUEST_CONTRACT_SCHEMAS) as [RequestContractId, typeof REQUEST_CONTRACT_SCHEMAS[RequestContractId]][]);

  for (const type of TASK_TYPES) {
    const cfg = TYPE_REGISTRY[type];
    byName.set(type, {
      name: type,
      kind: 'builtin',
      requestContract: type,
      defaultTier: cfg.defaultTier,
      sandbox: cfg.sandbox,
      worktree: cfg.worktree,
      reviewerTier: oppositeAgent(cfg.defaultTier),
      targetAcceptance: cfg.targetAcceptance,
      coreSkills: null,
      callerSkillPath: null,
    });
  }

  const seen = new Set<string>();
  for (const custom of customTypes) {
    if (seen.has(custom.name)) fail('custom_type_duplicate', custom.name, 'name', 'duplicate custom type name');
    seen.add(custom.name);

    if ((TASK_TYPES as readonly string[]).includes(custom.name)) {
      fail('custom_type_name_collision', custom.name, 'name', 'collides with built-in task type');
    }

    if (!(custom.requestContract in REQUEST_CONTRACT_SCHEMAS)) {
      fail('custom_type_invalid_contract', custom.name, 'requestContract', `unsupported contract ${custom.requestContract}`);
    }

    const callerSkillName = `mma-${custom.name}`;
    if (builtinCallerSkillNames.includes(callerSkillName)) {
      fail('custom_type_name_collision', custom.name, 'skillPaths.caller', `generated skill name ${callerSkillName} collides with built-in skill`);
    }

    const baseConfig = TYPE_REGISTRY[custom.requestContract as TaskType];
    const implementPath = resolveSkillPath(configPath, custom.skillPaths.implement);
    const reviewPath = resolveSkillPath(configPath, custom.skillPaths.review);
    const callerPath = resolveSkillPath(configPath, custom.skillPaths.caller);

    for (const [field, file] of [['skillPaths.implement', implementPath], ['skillPaths.review', reviewPath], ['skillPaths.caller', callerPath]] as const) {
      try {
        fs.accessSync(file, fs.constants.R_OK);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'custom_type_skill_missing'
          : 'custom_type_skill_unreadable';
        fail(code, custom.name, field, file);
      }
    }

    byName.set(custom.name, {
      name: custom.name,
      kind: 'custom',
      requestContract: custom.requestContract,
      defaultTier: custom.defaultTier,
      sandbox: custom.sandbox,
      worktree: baseConfig.worktree,
      reviewerTier: oppositeAgent(custom.defaultTier),
      targetAcceptance: baseConfig.targetAcceptance,
      coreSkills: {
        implementPath,
        reviewPath,
      },
      callerSkillPath: callerPath,
    });
  }

  return {
    types: [...byName.keys()],
    byName,
    requestContracts,
  };
}
```

Update [packages/core/src/index.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/index.ts) to export the new modules.

Find the existing exports section for unified types (around line 104-116) and add after the existing `taskInputSchema` export:

```ts
export {
  REQUEST_CONTRACT_SCHEMAS,
  buildBuiltInTaskInputSchema,
  taskEnvelopeSchema,
  validateTaskInput,
} from './unified/request-contracts.js';
export type { TaskValidationCatalog, RequestContractId } from './unified/request-contracts.js';

export { buildTaskCatalog } from './unified/task-catalog.js';
export type { ResolvedTaskCatalog, ResolvedTypeConfig } from './unified/task-catalog.js';
export { loadRegisteredSkill } from './unified/skill-loader.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unified/task-catalog.test.ts`
Expected: PASS

**Track I verification**

Run: `pnpm vitest run tests/config/load-config-custom-types.test.ts tests/unified/request-contracts.test.ts tests/unified/task-catalog.test.ts`
Expected: PASS

---

## Track II: Runtime Dispatch Integration

### Task II-1: Make Skill Loading Descriptor-Aware (AC-2.4)

**Files:**
- Modify: `packages/core/src/unified/skill-loader.ts`
- Test: `tests/unified/custom-skill-loader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearSkillCache,
  loadRegisteredSkill,
} from '../../packages/core/src/unified/skill-loader.js';
import type { ResolvedTypeConfig } from '../../packages/core/src/unified/task-catalog.js';

afterEach(() => clearSkillCache());

describe('loadRegisteredSkill', () => {
  it('reads custom implement/review prompts from resolved absolute paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-custom-skills-'));
    const implementPath = path.join(root, 'implement.md');
    const reviewPath = path.join(root, 'review.md');
    fs.writeFileSync(implementPath, 'Custom implementer');
    fs.writeFileSync(reviewPath, 'Custom reviewer');

    const descriptor: ResolvedTypeConfig = {
      name: 'security-audit',
      kind: 'custom',
      requestContract: 'audit',
      defaultTier: 'complex',
      sandbox: 'read-only',
      worktree: false,
      reviewerTier: 'standard',
      targetAcceptance: { paths: true, inline: true, required: true },
      coreSkills: { implementPath, reviewPath },
      callerSkillPath: path.join(root, 'SKILL.md'),
    };

    const pair = await loadRegisteredSkill(descriptor, '/unused');
    expect(pair.implement).toBe('Custom implementer');
    expect(pair.review).toBe('Custom reviewer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unified/custom-skill-loader.test.ts`
Expected: FAIL because `loadRegisteredSkill()` does not exist.

- [ ] **Step 3: Write minimal implementation**

Extend [packages/core/src/unified/skill-loader.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/core/src/unified/skill-loader.ts) with:

```ts
import type { ResolvedTypeConfig } from './task-catalog.js';

function descriptorCacheKey(descriptor: ResolvedTypeConfig, subtype?: string): string {
  return descriptor.kind === 'builtin'
    ? cacheKey(descriptor.name as TaskType, subtype)
    : `${descriptor.name}:custom`;
}

export async function loadRegisteredSkill(
  descriptor: ResolvedTypeConfig,
  skillsDir: string,
  subtype?: string,
): Promise<SkillPair> {
  const key = descriptorCacheKey(descriptor, subtype);
  const cached = cache.get(key);
  if (cached) return cached;

  // Custom types have coreSkills set; built-ins have null and use bundled loader
  if (descriptor.coreSkills) {
    const [implement, review] = await Promise.all([
      fs.readFile(descriptor.coreSkills.implementPath, 'utf-8'),
      fs.readFile(descriptor.coreSkills.reviewPath, 'utf-8'),
    ]);
    const pair: SkillPair = { implement, review };
    cache.set(key, pair);
    return pair;
  }

  // Built-in type: use the existing bundled loader
  const pair = await loadSkill(descriptor.name as TaskType, skillsDir, subtype);
  cache.set(key, pair);
  return pair;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unified/custom-skill-loader.test.ts`
Expected: PASS

### Task II-2: Build The Catalog At Server Startup And Fail Closed (AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-3.3)

**Files:**
- Modify: `packages/server/src/http/handler-deps.ts`
- Modify: `packages/server/src/http/server.ts`
- Test: `tests/http/custom-task-startup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../packages/server/src/http/server.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

function baseConfig(tokenFile: string): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'codex', model: 'test-standard', baseUrl: 'https://example.test/v1' },
      complex: { type: 'codex', model: 'test-complex', baseUrl: 'https://example.test/v1' },
    },
    defaults: {},
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile },
      limits: {
        maxBodyBytes: 10_485_760,
        batchTtlMs: 3_600_000,
        idleProjectTimeoutMs: 1_800_000,
        projectCap: 200,
        maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32,
        shutdownDrainMs: 30_000,
      },
      autoUpdateSkills: false,
    },
    research: {
      brave: { apiKeys: [], timeoutMs: 8000, maxResultsPerQuery: 20, perCallBackoffMs: 250, minPerKeyIntervalMs: 1100 },
      builtinAdapters: { arxiv: true, semanticScholar: true, githubSearch: true, openalex: true, crossref: true, pubmed: true },
    },
  };
}

describe('server custom task startup', () => {
  it('rejects startup before bind when a custom type collides with a built-in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-startup-'));
    const tokenFile = path.join(root, 'auth-token');
    fs.writeFileSync(tokenFile, 'test-token\\n');
    const configPath = path.join(root, 'config.json');

    const config = baseConfig(tokenFile);
    config.customTypes = [
      {
        name: 'audit',
        requestContract: 'audit',
        defaultTier: 'complex',
        sandbox: 'read-only',
        skillPaths: { implement: './implement.md', review: './review.md', caller: './SKILL.md' },
      },
    ];

    await expect(startServer(config, { driftReport: () => [] }, configPath)).rejects.toThrow(
      /custom_type_name_collision/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/http/custom-task-startup.test.ts`
Expected: FAIL because `startServer()` still ignores `customTypes`.

- [ ] **Step 3: Write minimal implementation**

Update [packages/server/src/http/handler-deps.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/http/handler-deps.ts):

```ts
import type { ResolvedTaskCatalog } from '@zhixuan92/multi-model-agent-core';

export interface HandlerDeps {
  config: MultiModelConfig;
  logWriter: LogWriter;
  bus: EnvelopeBus;
  projectRegistry: ProjectRegistry;
  taskRegistry: TaskRegistry;
  taskCatalog: ResolvedTaskCatalog;
}
```

Update [packages/server/src/http/server.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/http/server.ts). Note: `startServer()` already accepts `configPath: string | undefined` as a parameter (verify by checking the function signature).

Import the new modules and build the catalog before creating `HandlerDeps`:

```ts
import { buildTaskCatalog } from '@zhixuan92/multi-model-agent-core';
import { SUPPORTED_SKILLS } from '../skill-install/discover.js';

// inside startServer(), before building HandlerDeps
// configPath is already a parameter; resolve it if not provided
const resolvedConfigPath = configPath ?? path.join(process.cwd(), '.mma.json');

const taskCatalog = buildTaskCatalog(
  multiModelConfig.customTypes ?? [],
  resolvedConfigPath,
  SUPPORTED_SKILLS,
);

const deps: HandlerDeps = {
  config: multiModelConfig,
  bus,
  logWriter,
  projectRegistry,
  taskRegistry,
  taskCatalog,
};
```

**Critical:** Do not catch catalog-construction errors here; let them reject `startServer()` before the listener reports ready. This implements the "fail closed" requirement.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/http/custom-task-startup.test.ts`
Expected: PASS

### Task II-3: Validate And Dispatch Custom Types Through The Unified Handler (AC-2.2, AC-2.3, AC-2.4, AC-2.5)

**Files:**
- Modify: `packages/server/src/http/handlers/unified-task.ts`
- Test: `tests/contract/http/custom-task-types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

describe('custom task types route contract', () => {
  it('accepts a registered custom audit alias and preserves the custom type in the task block', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-route-custom-'));
    fs.mkdirSync(path.join(root, 'skills', 'security-audit'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'mma-security-audit'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'security-audit', 'implement.md'), 'Implementer');
    fs.writeFileSync(path.join(root, 'skills', 'security-audit', 'review.md'), 'Refiner');
    fs.writeFileSync(path.join(root, 'skills', 'mma-security-audit', 'SKILL.md'), 'Caller');

    const h = await boot({
      provider: mockProvider({ stage: 'ok' }),
      cwd: process.cwd(),
      configOverrides: {
        customTypes: [
          {
            name: 'security-audit',
            requestContract: 'audit',
            defaultTier: 'complex',
            sandbox: 'read-only',
            skillPaths: {
              implement: path.join(root, 'skills', 'security-audit', 'implement.md'),
              review: path.join(root, 'skills', 'security-audit', 'review.md'),
              caller: path.join(root, 'skills', 'mma-security-audit', 'SKILL.md'),
            },
          },
        ],
      },
      configPath: path.join(root, 'config.json'),
    });

    try {
      const dispatch = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: HEADERS(h.token),
        body: JSON.stringify({ type: 'security-audit', target: { paths: ['/tmp/a.md'] } }),
      });

      expect(dispatch.status).toBe(202);
    } finally {
      await h.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/contract/http/custom-task-types.test.ts`
Expected: FAIL because `buildUnifiedTaskHandler()` still validates against the static built-in discriminated union.

- [ ] **Step 3: Write minimal implementation**

Update [packages/server/src/http/handlers/unified-task.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/http/handlers/unified-task.ts):

```ts
import {
  validateTaskInput,
  loadRegisteredSkill,
} from '@zhixuan92/multi-model-agent-core';

// inside buildUnifiedTaskHandler()
let parsedInput: Record<string, unknown>;
try {
  parsedInput = validateTaskInput(ctx.body, deps.taskCatalog);
} catch (err) {
  const message = err instanceof Error ? err.message : 'Validation failed';
  const details = message.startsWith('unknown_task_type:')
    ? {
        code: 'unknown_task_type',
        type: String((ctx.body as Record<string, unknown>)?.type ?? ''),
      }
    : { message };
  sendError(res, 400, 'invalid_request', 'Validation failed', details);
  return;
}

const input = parsedInput as Record<string, unknown> & { type: string; reviewPolicy?: 'reviewed' | 'none' };
const descriptor = deps.taskCatalog.byName.get(input.type);
if (!descriptor) {
  sendError(res, 400, 'invalid_request', 'Validation failed', {
    code: 'unknown_task_type',
    type: input.type,
  });
  return;
}

const contractType = descriptor.requestContract as TaskType;
const implTier = (input.agentTier as AgentType | undefined) ?? descriptor.defaultTier;
const revTier = descriptor.reviewerTier;
const reviewPolicy = contractType === 'orchestrate' ? 'none' : (input.reviewPolicy ?? 'reviewed');

let skills;
try {
  const subtype = typeof input.subtype === 'string' ? input.subtype : undefined;
  skills = await loadRegisteredSkill(descriptor, SKILLS_DIR, subtype);
} catch (err) {
  sendError(res, 500, 'skill_load_failed', err instanceof Error ? err.message : 'Skill load failed');
  return;
}

const pipelineResult = await runTwoPhasePipeline({
  type: contractType,
  implementerSkill: skills.implement,
  reviewerSkill: skills.review,
  taskPayload: JSON.stringify(payload, null, 2),
  implementerProvider: implAgent.provider,
  reviewerProvider: revAgent.provider,
  implementerTier: implTier,
  reviewerTier: revTier,
  reviewPolicy,
  cwd,
  sandboxPolicy: descriptor.sandbox,
  worktreeEnabled: descriptor.worktree,
  taskId,
  implementerGoal: buildGoalCondition(contractType, 'implementer', skills.implement),
  reviewerGoal: buildGoalCondition(contractType, 'reviewer', skills.review),
});
```

Also update the test harness so `boot()` can pass `configOverrides` and `configPath` through to `startServer()`; use the existing base fixture rather than inventing a second startup helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/contract/http/custom-task-types.test.ts`
Expected: PASS

**Track II verification**

Run: `pnpm vitest run tests/unified/custom-skill-loader.test.ts tests/http/custom-task-startup.test.ts tests/contract/http/custom-task-types.test.ts`
Expected: PASS

---

## Track III: Caller Skill Sync Integration

### Task III-1: Extract Shared Config Discovery And Installable Skill Sources (AC-3.1, AC-3.2, AC-3.3)

**Files:**
- Create: `packages/server/src/cli/config-discovery.ts`
- Create: `packages/server/src/skill-install/installable-skill-sources.ts`
- Test: `tests/cli/installable-skill-sources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInstallableSkillSources } from '../../packages/server/src/skill-install/installable-skill-sources.js';

describe('loadInstallableSkillSources', () => {
  it('appends custom caller-facing skills after built-ins when config loads successfully', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-installable-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-installable-cwd-'));
    const configPath = path.join(cwd, '.mma.json');

    fs.mkdirSync(path.join(cwd, 'skills', 'security-audit'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'skills', 'mma-security-audit'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'skills', 'security-audit', 'implement.md'), 'Implementer');
    fs.writeFileSync(path.join(cwd, 'skills', 'security-audit', 'review.md'), 'Refiner');
    fs.writeFileSync(path.join(cwd, 'skills', 'mma-security-audit', 'SKILL.md'), '---\\nname: mma-security-audit\\nversion: 1.0.0\\n---\\ncaller');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        standard: { type: 'codex', model: 'test-standard', baseUrl: 'https://example.test/v1' },
        complex: { type: 'codex', model: 'test-complex', baseUrl: 'https://example.test/v1' },
      },
      customTypes: [
        {
          name: 'security-audit',
          requestContract: 'audit',
          defaultTier: 'complex',
          sandbox: 'read-only',
          skillPaths: {
            implement: './skills/security-audit/implement.md',
            review: './skills/security-audit/review.md',
            caller: './skills/mma-security-audit/SKILL.md',
          },
        },
      ],
    }));

    const sources = await loadInstallableSkillSources({
      cwd,
      homeDir: home,
      env: {},
    });

    expect(sources.some((s) => s.name === 'mma-security-audit' && s.origin === 'custom')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/installable-skill-sources.test.ts`
Expected: FAIL with module-not-found errors for the new helper files.

- [ ] **Step 3: Write minimal implementation**

Create [packages/server/src/cli/config-discovery.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/cli/config-discovery.ts):

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFromFile, type MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

export function buildCandidatePaths(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
  home: string,
): string[] {
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  const envVal = (env.MMA_CONFIG ?? '').trim();
  if (envVal) paths.push(envVal);
  paths.push(path.join(cwd, '.mma.json'));
  paths.push(path.join(cwd, '.multi-model-agent.json'));
  paths.push(path.join(home, '.mma', 'config.json'));
  return paths;
}

export async function loadDiscoveredConfig(input: {
  explicitPath?: string;
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ config: MultiModelConfig; configPath: string }> {
  const cwd = input.cwd ?? process.cwd();
  const homeDir = input.homeDir ?? os.homedir();
  const env = input.env ?? process.env;

  for (const candidate of buildCandidatePaths(input.explicitPath, env, cwd, homeDir)) {
    if (!fs.existsSync(candidate)) continue;
    const config = await loadConfigFromFile(candidate);
    return { config, configPath: candidate };
  }

  throw new Error('No config file found');
}
```

Create [packages/server/src/skill-install/installable-skill-sources.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/skill-install/installable-skill-sources.ts):

```ts
import fs from 'node:fs';
import { buildTaskCatalog } from '@zhixuan92/multi-model-agent-core';
import { loadDiscoveredConfig } from '../cli/config-discovery.js';
import { SUPPORTED_SKILLS, readSkillContent } from './discover.js';

export interface InstallableSkillSource {
  name: string;
  content: string;
  origin: 'builtin' | 'custom';
}

export async function loadInstallableSkillSources(input: {
  explicitConfigPath?: string;
  cwd?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  skillsRoot?: string;
} = {}): Promise<InstallableSkillSource[]> {
  const builtins = SUPPORTED_SKILLS.map((name) => {
    const content = readSkillContent(name, input.skillsRoot);
    if (content === null) {
      throw new Error(`Bundled skill missing: ${name}`);
    }
    return { name, content, origin: 'builtin' as const };
  });

  try {
    const { config, configPath } = await loadDiscoveredConfig({
      explicitPath: input.explicitConfigPath,
      cwd: input.cwd,
      homeDir: input.homeDir,
      env: input.env,
    });
    const catalog = buildTaskCatalog(config.customTypes ?? [], configPath, SUPPORTED_SKILLS);
    const customs = [...catalog.byName.values()]
      .filter((d) => d.kind === 'custom' && d.callerSkillPath)
      .map((d) => ({
        name: `mma-${d.name}`,
        content: fs.readFileSync(d.callerSkillPath!, 'utf-8'),
        origin: 'custom' as const,
      }));
    return [...builtins, ...customs];
  } catch {
    return builtins;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/cli/installable-skill-sources.test.ts`
Expected: PASS

### Task III-2: Teach `mma sync-skills` To Install Custom Caller Skills (AC-3.1, AC-3.2, AC-3.3)

**Files:**
- Modify: `packages/server/src/cli/index.ts`
- Modify: `packages/server/src/cli/sync-skills.ts`
- Test: `tests/cli/sync-skills-custom.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runSyncSkills } from '../../packages/server/src/cli/sync-skills.js';

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'mma-sync-custom-home-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

describe('sync-skills custom types', () => {
  it('installs a caller-facing custom skill and reports origin in --json output', async () => {
    const home = makeHome();
    const cwd = mkdtempSync(path.join(tmpdir(), 'mma-sync-custom-cwd-'));
    try {
      mkdirSync(path.join(cwd, 'skills', 'security-audit'), { recursive: true });
      mkdirSync(path.join(cwd, 'skills', 'mma-security-audit'), { recursive: true });
      writeFileSync(path.join(cwd, 'skills', 'security-audit', 'implement.md'), 'Implementer');
      writeFileSync(path.join(cwd, 'skills', 'security-audit', 'review.md'), 'Refiner');
      writeFileSync(path.join(cwd, 'skills', 'mma-security-audit', 'SKILL.md'), '---\\nname: mma-security-audit\\nversion: 1.0.0\\n---\\ncaller');
      writeFileSync(path.join(cwd, '.mma.json'), JSON.stringify({
        agents: {
          standard: { type: 'codex', model: 'test-standard', baseUrl: 'https://example.test/v1' },
          complex: { type: 'codex', model: 'test-complex', baseUrl: 'https://example.test/v1' },
        },
        customTypes: [
          {
            name: 'security-audit',
            requestContract: 'audit',
            defaultTier: 'complex',
            sandbox: 'read-only',
            skillPaths: {
              implement: './skills/security-audit/implement.md',
              review: './skills/security-audit/review.md',
              caller: './skills/mma-security-audit/SKILL.md',
            },
          },
        ],
      }));

      let stdout = '';
      const code = await runSyncSkills({
        argv: ['--json'],
        homeDir: home,
        cwd,
        stdout: (s: string) => { stdout += s; return true; },
      });

      expect(code).toBe(0);
      expect(stdout).toMatch(/mma-security-audit/);
      expect(stdout).toMatch(/"origin":"custom"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/sync-skills-custom.test.ts`
Expected: FAIL because `runSyncSkills()` still iterates only `SUPPORTED_SKILLS`.

- [ ] **Step 3: Write minimal implementation**

Update [packages/server/src/cli/index.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/cli/index.ts). This step resolves the circular import issue mentioned in Ground Truth: the CLI and sync-skills both need config discovery, but they can't both live in `index.ts`. Extract the discovery helpers to `config-discovery.ts` (created in this task), then update `index.ts` to import from there instead of implementing discovery locally. Replace any duplicated discovery logic in `index.ts` with imports from `./config-discovery.js`.

Update [packages/server/src/cli/sync-skills.ts](/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/41048369/packages/server/src/cli/sync-skills.ts):

```ts
import { loadInstallableSkillSources } from '../skill-install/installable-skill-sources.js';

export interface SyncSkillsDeps {
  argv?: string[];
  homeDir?: string;
  cwd?: string;
  skillsRoot?: string;
  ifExists?: boolean;
  silent?: boolean;
  bestEffort?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

// inside runSyncSkills()
const cwd = deps.cwd ?? process.cwd();
const sources = await loadInstallableSkillSources({
  cwd,
  homeDir,
  env: process.env,
  skillsRoot,
});
const canonicalSkills = sources.map((s) => s.name);

for (const entry of manifestEntries) {
  if (canonicalSkills.includes(entry.name)) continue;
  // existing orphan-removal logic unchanged
}

for (const source of sources) {
  const skillName = source.name;
  const content = source.content;
  const version = versionFromContent(content);
  // existing install / update / up-to-date branches stay the same
}

if (parsed.json) {
  stdout(JSON.stringify({
    targets,
    outcome,
    skills: sources.map((s) => ({ name: s.name, origin: s.origin, version: versionFromContent(s.content) })),
  }) + '\n');
  return outcome.errors.length > 0 ? ExitCode.ERR_PARTIAL : ExitCode.SUCCESS;
}
```

Keep the current silent-failure rule by relying on `loadInstallableSkillSources()` returning built-ins only when config discovery or custom catalog validation fails.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/cli/sync-skills-custom.test.ts`
Expected: PASS

**Track III verification**

Run: `pnpm vitest run tests/cli/installable-skill-sources.test.ts tests/cli/sync-skills-custom.test.ts`
Expected: PASS

---

## Performance Verification (AC-3.4)

Task I-3 should include a performance test that measures `buildTaskCatalog()` construction time with 25 custom types. Add to the task-catalog.test.ts:

```ts
it('constructs a catalog with 25 custom types in under 100 ms', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-perf-'));
  
  // Create 25 custom type configs with dummy skill files
  const customTypes: RuntimeCustomTypeConfig[] = [];
  for (let i = 0; i < 25; i++) {
    const name = `custom-type-${i}`;
    writeSkill(root, `skills/${name}/implement.md`, 'Impl');
    writeSkill(root, `skills/${name}/review.md`, 'Rev');
    writeSkill(root, `skills/mma-${name}/SKILL.md`, 'Caller');
    customTypes.push({
      name,
      requestContract: 'audit',
      defaultTier: 'complex',
      sandbox: 'read-only',
      skillPaths: {
        implement: `./skills/${name}/implement.md`,
        review: `./skills/${name}/review.md`,
        caller: `./skills/mma-${name}/SKILL.md`,
      },
    });
  }
  
  const configPath = path.join(root, 'config.json');
  const start = performance.now();
  buildTaskCatalog(customTypes, configPath, ['mma-audit']);
  const elapsed = performance.now() - start;
  
  expect(elapsed).toBeLessThan(100);
});
```

## Final Verification

Run:

```bash
pnpm vitest run \
  tests/config/load-config-custom-types.test.ts \
  tests/unified/request-contracts.test.ts \
  tests/unified/task-catalog.test.ts \
  tests/unified/custom-skill-loader.test.ts \
  tests/http/custom-task-startup.test.ts \
  tests/contract/http/custom-task-types.test.ts \
  tests/cli/installable-skill-sources.test.ts \
  tests/cli/sync-skills-custom.test.ts \
  tests/unified/task-input-schema.test.ts \
  tests/unified/type-registry.test.ts \
  tests/cli/sync-skills.test.ts \
  tests/contract/http/route-contract.test.ts
```

Expected: PASS (including performance assertion in task-catalog.test.ts)

## Acceptance Criteria Mapping

- AC-1.1: Task I-1
- AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6: Tasks I-3, II-2
- AC-2.1: Task I-3
- AC-2.2: Tasks I-2, II-3
- AC-2.3: Task II-3
- AC-2.4: Tasks II-1, II-3
- AC-2.5: Tasks I-2, II-3
- AC-3.1, AC-3.2: Tasks III-1, III-2
- AC-3.3: Tasks II-2, III-2 plus the final regression run
- AC-3.4: Task I-3
