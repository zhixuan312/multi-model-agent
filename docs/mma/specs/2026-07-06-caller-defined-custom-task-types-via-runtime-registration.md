---
version: 1
updated_at: 2026-07-06
---

# Caller-Defined Custom Task Types Via Runtime Registration

## Context

### Background
Multi Model Agent exposes a unified `POST /task` entrypoint whose `type` discriminator selects a two-phase execution path: an implementer runs first and a reviewer/refiner runs second unless `reviewPolicy: "none"` disables the review stage. At HEAD, the type system is static. `packages/core/src/unified/type-registry.ts` exports a fixed `TASK_TYPES` tuple and `TYPE_REGISTRY` record. `packages/core/src/unified/task-input-schema.ts` validates requests through a `z.discriminatedUnion('type', ...)` whose variants are hardcoded to those built-in task names. `packages/core/src/unified/skill-loader.ts` loads implementer and reviewer prompts from `packages/core/src/skills/<type>/implement.md` and `review.md`. `packages/server/src/http/handlers/unified-task.ts` resolves the type config through `getTypeConfig(input.type)` and then loads the skill pair for that same type.

The installation surface for caller-visible skills is also static today. `packages/server/src/skill-install/discover.ts` exports a fixed `SUPPORTED_SKILLS` list, and `packages/server/src/cli/sync-skills.ts` reconciles only those bundled `packages/server/src/skills/<skill>/SKILL.md` files into supported clients.

The product direction is to let teams extend the rod set without forking MMA. A common example is a team-specific gate such as `security-audit`, where the runtime contract is similar to an existing MMA task shape but the implementer prompt, reviewer prompt, and caller-facing skill instructions are team-owned artifacts on disk.

## Problem

Teams that need a custom task type today must modify the repository and ship a fork because there is no runtime registration path for new `type` values, no config-driven loading of custom implementer/reviewer prompts, and no way for `mma sync-skills` to surface caller-facing skills for those custom types. That blocks local extension, slows adoption of new team-specific gates, and creates avoidable divergence from upstream MMA.

### Assumptions

1. **Frozen request contract ID set**: The set of valid `requestContract` ids (audit, investigate, review, debug, research, journal_recall, journal_record, delegate, execute_plan, retry_tasks, orchestrate) is immutable after implementation. Custom types can only alias one of these existing contracts; they cannot define new HTTP request shapes or introduce new contract variants.
2. **Config file exists at discovery time**: If `customTypes` are declared, all three skill files (`implement`, `review`, `caller`) must be readable from disk during config load (startup for `mma serve`, per-invocation for `mma sync-skills`). File IO failures are fatal for `serve` but silent for `sync-skills`.
3. **Relative path resolution is deterministic**: Relative skill paths resolve from `dirname(configPath)`, where `configPath` is the absolute path of the config file discovered via the standard search order. This ensures the same config behaves consistently across `serve`, `sync-skills`, and tests.
4. **No runtime mutation of task catalog**: The resolved task catalog is constructed once at startup or at the beginning of a CLI invocation and is treated as immutable for the lifetime of that process. In-flight requests cannot see new custom types registered mid-process.

## Goals & Requirements

### Goals
1. Teams can register custom task types at runtime through config only, without modifying MMA source.
2. Registered custom types execute through the same two-phase pipeline used by built-in types.
3. Registered custom types can supply their own implementer prompt, reviewer prompt, and caller-facing `SKILL.md`.
4. The runtime rejects invalid or colliding registrations deterministically at startup.

### Functional requirements
- FR-1. The config schema must accept a top-level `customTypes` array in `config.json`.
- FR-2. Each `customTypes[]` entry must declare `name`, `requestContract`, `defaultTier`, `sandbox`, and `skillPaths`.
- FR-3. `name` must match the regex `^[a-z][a-z0-9_-]{1,63}$` and must not equal any built-in task type name.
- FR-4. `requestContract` must select one existing MMA request schema by id from this frozen enum: `audit`, `investigate`, `review`, `debug`, `research`, `journal_recall`, `journal_record`, `delegate`, `execute_plan`, `retry_tasks`, `orchestrate`.
- FR-5. `defaultTier` must validate through the same enum used for built-ins: `standard | complex | main`.
- FR-6. `sandbox` must validate through the same enum used for built-ins: `read-only | cwd-only`.
- FR-7. `skillPaths` must include `implement`, `review`, and `caller`, each as a non-empty path string. Relative paths must resolve from the directory that contains the loaded config file. Absolute paths may also be used.
- FR-8. At startup, MMA must build one runtime task catalog by merging the built-in registry with all valid custom registrations from config.
- FR-9. A custom type must inherit its request-body validation contract from the selected `requestContract` and must be validated by the same Zod schema implementation used by the referenced built-in contract, not by a looser fallback parser.
- FR-10. The unified task handler must accept a registered custom type in `POST /task`, load its configured implementer and reviewer prompts, and dispatch it through the existing two-phase pipeline without a special-case execution branch.
- FR-11. `mma sync-skills` must include caller-facing skills for registered custom types in both normal text output and `--json` output, using the configured `skillPaths.caller` content as the source file.
- FR-12. The runtime must reject duplicate custom type names, collisions with built-ins, missing skill files, unsupported `requestContract` values, and invalid config shapes before the server begins accepting requests.
- FR-13. Startup rejection errors for invalid custom types must identify the failing custom type name, the invalid field or file path, and the reason in a structured error message with error code, type name, and field/path reference.
- FR-14. Registering custom types must not change the behavior of existing built-in task types when `customTypes` is absent or empty.
- FR-15. The set of valid `requestContract` ids is frozen at implementation time and immutable thereafter; no mechanism allows runtime mutation of which contract IDs are valid.

### Scope

#### In scope
- Extending the config schema to describe custom task types.
- Runtime registry construction from built-ins plus config-defined custom types.
- Reusing built-in Zod request contracts for custom types through a contract lookup layer.
- Config-driven loading of custom implementer and reviewer prompts.
- Config-driven loading and installation of caller-facing `SKILL.md` files during `mma sync-skills`.
- Startup-time validation for collisions, missing files, invalid schema references, and invalid enum values.
- Unit and integration tests for registration, validation, dispatch, and skill sync output.

#### Out of scope
- Arbitrary JavaScript plugin loading or custom provider executors.
- Caller-defined output parsers, refiner schemas, or review criteria beyond prompt contents.
- Hot registration over HTTP after the process has started.
- Dynamic mutation of the registry while tasks are in flight.
- Non-file skill sources such as URLs, package names, or database-backed prompts.
- Changes to the unified `POST /task` transport, auth headers, polling contract, or review-policy semantics.

### Constraints
- The implementation must preserve current behavior for built-in types and must remain backward compatible for existing `config.json` files that do not define `customTypes`.
- The implementation must respect the existing sandbox model and may only allow `read-only` or `cwd-only`.
- The implementation must validate custom request bodies with the same Zod contract code used by built-ins, not an ad hoc handwritten validator.
- Startup registration overhead for a typical custom-type set must stay below `100 ms` on local disk for up to `25` custom types.
- The implementation must fail closed: invalid custom registrations prevent startup rather than being skipped silently.
- Relative skill paths must resolve deterministically from the loaded config file location so the same config behaves the same under `mma serve`, `mma sync-skills`, and tests.

### Success metrics

| Metric | Target | How measured |
|---|---|---|
| Registration time | Less than `100 ms` during startup for `25` custom types on local disk | Unit test or integration test with injected clock around catalog construction |
| Type collision handling | `100%` of built-in or duplicate-name collisions rejected before server ready | Startup validation tests |
| Validation parity | `100%` of custom-type requests validated by the same Zod contract as their referenced built-in contract | Schema tests comparing pass/fail parity |
| Dispatch parity | `100%` of valid custom-type requests reach the existing two-phase pipeline without a custom execution branch | Unified handler integration tests |
| Skill sync coverage | `100%` of registered custom caller skills appear in `mma sync-skills` text and JSON output | CLI tests |

## Alternatives

### Driving factors
1. Reuse the existing pipeline and validation code instead of inventing a second execution model.
2. Keep extension local to disk-based config and files so the feature remains simple to operate.
3. Fail invalid registrations early and clearly.
4. Avoid broadening the security surface with executable plugin code.
5. Keep built-in behavior unchanged when no custom types are configured.

### Options

#### Option A: Config-driven runtime registration with contract aliases and file-backed skill paths
Load custom types from `config.json`, map each one to an existing request contract id, validate all files and collisions at startup, and expose caller-facing skills through `sync-skills`.

Pros:
- Matches the stated requirement for runtime config registration.
- Reuses existing pipeline, validation, and skill-install flows.
- Keeps extension fully declarative and reviewable.
- Has deterministic startup behavior with no runtime mutation.

Cons:
- Requires refactoring the hardcoded `z.discriminatedUnion` and static type registry into a runtime catalog.
- Only supports request shapes that alias an existing contract; it does not allow brand-new HTTP shapes.

#### Option B: Add more built-in task types upstream for each use case
Continue to gate every new task type through repository changes and releases.

Pros:
- Keeps the runtime fully static.
- Avoids refactoring the current registry and schema implementation.

Cons:
- Does not solve the extension problem.
- Forces forks or upstream wait time for team-specific gates.
- Scales poorly as the rod set grows.

#### Option C: HTTP API registration after startup
Expose an administrative endpoint that accepts task-type definitions and mutates the runtime registry dynamically.

Pros:
- No restart required to add a type.
- Can support interactive registration flows.

Cons:
- Adds state management, mutation ordering, and auth complexity.
- Makes `sync-skills` and server startup behavior less deterministic.
- Expands the operational and security surface beyond the stated need.

### Comparison

| Factor | Option A: Config registration | Option B: Built-ins only | Option C: HTTP registration |
|---|---|---|---|
| Solves local extension need | Yes | No | Yes |
| Reuses current pipeline | Yes | Yes | Yes |
| Startup determinism | High | High | Low |
| Operational complexity | Low | Medium | High |
| Security surface | Low | Low | Medium |
| Implementation effort | Moderate | Low short term, high long term | High |
| Fit for caller-owned prompts on disk | High | Low | Medium |

## Decision Records

1. Decision: Use config-driven registration at startup.
Rationale: The requirement is specifically runtime registration via config, and startup-time loading keeps the system deterministic, auditable, and simple to operate.

2. Decision: Reuse existing request schemas through a `requestContract` alias rather than allowing arbitrary request-schema definitions in config.
Rationale: The design input requires custom types to validate through the same Zod schema. A contract alias is the smallest mechanism that preserves exact schema reuse while avoiding executable schema code in config.

3. Decision: Require three custom skill files per type: `implement`, `review`, and `caller`.
Rationale: The runtime needs implementer and reviewer prompts for pipeline execution, and `mma sync-skills` needs a caller-facing `SKILL.md` source. Making all three explicit removes ambiguity.

4. Decision: Fail startup on any invalid custom type instead of partially loading the valid subset.
Rationale: Silent skips would make available task types environment-dependent and hard to reason about. Failing closed gives operators one clear correction loop.

5. Decision: Resolve relative skill paths from the loaded config file directory.
Rationale: That is the only stable reference point shared by `serve`, `sync-skills`, and tests. Resolving against process cwd would be brittle.

6. Decision: Keep built-in task types as the immutable baseline and merge custom types into a separate runtime catalog.
Rationale: Built-ins remain part of MMA’s public contract. Treating them as the canonical base avoids accidental mutation and simplifies backward compatibility.

## Technical Design

### Current state

At HEAD:

- `packages/core/src/unified/type-registry.ts` exports a hardcoded `TASK_TYPES` array with `11` entries and a `TYPE_REGISTRY: Record<TaskType, TypeConfig>`. The design prompt said MMA ships `13` built-in task types, but the checked-in code currently exposes `11`; the implementation must follow code reality, not the stale count in the design summary.
- `packages/core/src/unified/task-input-schema.ts` uses `z.discriminatedUnion('type', [...])` with one static variant per built-in task type. That structure cannot admit arbitrary runtime-defined `type` strings.
- `packages/core/src/unified/skill-loader.ts` loads prompts from `packages/core/src/skills/<type>/implement.md` and `review.md`, assuming the type name maps directly to a bundled directory under the repo.
- `packages/server/src/http/handlers/unified-task.ts` validates requests with `taskInputSchema`, resolves type config with `getTypeConfig(input.type)`, and loads skills with `loadSkill(input.type, SKILLS_DIR, subtype)`.
- `packages/core/src/config/schema.ts` defines `multiModelConfigSchema` and currently has no `customTypes` field.
- `packages/core/src/config/load.ts` parses config through `multiModelConfigSchema`, so any new config field must be added there to load successfully.
- `packages/server/src/skill-install/discover.ts` exports a fixed `SUPPORTED_SKILLS` list of caller-facing shipped skills and reads only bundled `packages/server/src/skills/<name>/SKILL.md` files.
- `packages/server/src/cli/sync-skills.ts` depends on `SUPPORTED_SKILLS` and has no hook for config-defined caller skills.

### Proposed design

#### Architecture

Introduce a runtime task catalog layer that separates immutable built-ins from the resolved catalog used by the server and CLI.

The architecture is:

1. Keep built-in metadata in a new immutable baseline module:
   - `BUILTIN_TASK_TYPES: readonly string[]`
   - `BUILTIN_TYPE_REGISTRY: Record<BuiltInTaskType, TypeConfig>`
   - `BUILTIN_REQUEST_CONTRACTS: Record<RequestContractId, ZodSchema>`
2. Add a config-driven catalog builder that:
   - parses `customTypes`
   - validates names, enums, contract ids, and file paths
   - resolves skill file paths to absolute paths
   - rejects collisions and duplicates
   - returns a `ResolvedTaskCatalog`
3. Pass the resolved catalog into the HTTP handler and `sync-skills` instead of reading only hardcoded module-level constants.
4. Replace the static discriminated-union ingress with a two-step validation flow:
   - validate the generic envelope enough to read `type`
   - resolve the task descriptor from the catalog
   - validate the full request body with the descriptor’s referenced Zod contract
5. Extend skill loading so built-ins continue to read bundled core prompts, while custom types read the configured absolute prompt paths.
6. Extend `sync-skills` so its canonical skill source set is `built-in shipped skills + generated custom entries from config`.

This preserves one pipeline and one request-validation system while making the task catalog runtime-extensible.

#### Interfaces / APIs

Config contract:

```json
{
  "customTypes": [
    {
      "name": "security-audit",
      "requestContract": "audit",
      "defaultTier": "complex",
      "sandbox": "read-only",
      "skillPaths": {
        "implement": "./skills/security-audit/implement.md",
        "review": "./skills/security-audit/review.md",
        "caller": "./skills/mma-security-audit/SKILL.md"
      }
    }
  ]
}
```

Frozen field contract for each `customTypes[]` entry:

```ts
type RequestContractId =
  | 'audit'
  | 'investigate'
  | 'review'
  | 'debug'
  | 'research'
  | 'journal_recall'
  | 'journal_record'
  | 'delegate'
  | 'execute_plan'
  | 'retry_tasks'
  | 'orchestrate';

type AgentTier = 'standard' | 'complex' | 'main';
type SandboxPolicy = 'read-only' | 'cwd-only';

interface CustomTypeConfig {
  name: string;
  requestContract: RequestContractId;
  defaultTier: AgentTier;
  sandbox: SandboxPolicy;
  skillPaths: {
    implement: string;
    review: string;
    caller: string;
  };
}
```

Resolved catalog contract:

```ts
interface ResolvedTypeConfig {
  name: string;
  kind: 'builtin' | 'custom';
  requestContract: RequestContractId;
  defaultTier: AgentTier;
  sandbox: SandboxPolicy;
  worktree: boolean;
  targetAcceptance: {
    paths: boolean;
    inline: boolean;
    required: boolean;
  };
  coreSkills: {
    implementPath: string;
    reviewPath: string;
  };
  callerSkillPath: string | null;
}

interface ResolvedTaskCatalog {
  types: string[];
  byName: Map<string, ResolvedTypeConfig>;
  requestContracts: Map<RequestContractId, z.ZodTypeAny>;
}
```

Required derivation rules:

- For built-ins, `requestContract`, `worktree`, and `targetAcceptance` are derived from the existing built-in definitions.
- For custom types, `worktree` and `targetAcceptance` are copied from the referenced `requestContract`’s built-in type config. This prevents config from drifting away from the contract it claims to reuse.
- For custom types, `coreSkills.implementPath`, `coreSkills.reviewPath`, and `callerSkillPath` are absolute resolved paths after config-path resolution.

Request validation flow:

1. Replace the current exported `taskInputSchema` as the sole ingress contract with:
   - `taskEnvelopeSchema`, which validates generic shared fields and `type: string`
   - `validateTaskInput(raw, catalog)`, which:
     - parses `taskEnvelopeSchema`
     - resolves `catalog.byName.get(type)`
     - throws `unknown_task_type` if missing
     - validates the full body against the Zod schema referenced by `descriptor.requestContract`
2. `validateTaskInput` must return the same parsed shape the handler consumes today, with the parsed `type` preserved as the custom name.

Skill loading flow:

```ts
interface LoadedSkillPair {
  implement: string;
  review: string;
}

async function loadRegisteredSkill(
  descriptor: ResolvedTypeConfig,
  bundledSkillsDir: string,
  subtype?: string,
): Promise<LoadedSkillPair>;
```

Behavior:

- Built-in descriptors continue to use the existing bundled lookup, including subtype fallback for audit variants.
- Custom descriptors ignore `subtype` and read exactly the configured `implementPath` and `reviewPath`.
- Missing files are startup validation failures for custom types and runtime `500 skill_load_failed` only for unexpected built-in packaging regressions.

`sync-skills` source contract:

```ts
interface InstallableSkillSource {
  name: string;
  content: string;
  origin: 'builtin' | 'custom';
}
```

Required naming rule:

- Each custom caller-facing skill is installed under the skill name `mma-<customTypeName>`.
- If that generated name collides with a built-in shipped skill directory name, startup validation must fail.

#### Data model

No persistent database changes are required. The feature adds config and in-memory catalog data only.

New config schema additions:

- `multiModelConfigSchema.customTypes: z.array(customTypeSchema).default([])`
- `customTypeSchema` must be `.strict()`
- `skillPaths` must be `.strict()`

New in-memory structures:

- `ResolvedTaskCatalog`
- `ResolvedTypeConfig` entries for built-ins and customs
- `RequestContractId` lookup map

New error codes exposed at startup or ingress:

- `custom_type_name_collision`
- `custom_type_duplicate`
- `custom_type_invalid_contract`
- `custom_type_skill_missing`
- `custom_type_skill_unreadable`
- `unknown_task_type`

These may be surfaced as structured config/validation errors while preserving existing HTTP `400 invalid_request` transport for request-body failures.

#### Implementation details

1. Registry refactor
Create a baseline module that preserves the current built-in definitions without mutation. Add a resolver function such as `buildTaskCatalog(customTypes, configPath)` in core. The function must:
- start from built-ins
- validate every custom entry
- resolve relative skill paths from `dirname(configPath)`
- ensure the generated caller skill name `mma-${name}` does not collide with built-in skill names from `packages/server/src/skill-install/discover.ts`
- return one immutable resolved catalog

2. Contract reuse
Break the current hardcoded `taskInputSchema` into reusable per-contract schemas keyed by request contract id. Each existing built-in route schema becomes addressable through the `RequestContractId` map. The custom type does not bring its own schema; it points to one of those existing contract objects.

3. Handler integration
`packages/server/src/http/handlers/unified-task.ts` must receive the resolved catalog through handler dependencies rather than importing only static globals. The handler must validate the request via `validateTaskInput(raw, catalog)`, resolve the type descriptor from the same catalog, and use descriptor-derived settings for tier, sandbox, and skill loading.

4. Skill loading
Generalize the core skill loader so it accepts a resolved descriptor instead of assuming `packages/core/src/skills/<type>/...`. Built-ins keep existing filesystem semantics. Custom types load the configured files directly.

5. Sync-skills integration
`mma sync-skills` must load config using the same discovery order already used by `mma serve`:
- `--config`
- `$MMA_CONFIG`
- `CWD/.mma.json`
- `CWD/.multi-model-agent.json`
- `~/.mma/config.json`

Config load failures (missing file, parse error, Zod validation failure, unreadable skill path) are **silent**: existing built-in skill sync behavior proceeds exactly as today, and no custom skills are installed. This preserves backward compatibility for workflows that run `sync-skills` in environments where config discovery may not be set up or may be permissive about custom-type errors. If config loads successfully, `sync-skills` must append custom `InstallableSkillSource` entries after the built-ins and treat them exactly like normal skills for install, update, dry-run, and JSON reporting.

6. Startup validation
Startup validation must run before the HTTP server reports ready. It must verify:
- custom type name format
- no duplicate names inside `customTypes`
- no collisions with built-in task types
- valid `requestContract`
- valid `defaultTier`
- valid `sandbox`
- readable `implement`, `review`, and `caller` files
- no generated caller-skill-name collision

7. Sandbox behavior
The `sandbox` field on a custom type must be the runtime sandbox passed into the pipeline exactly like built-ins. Because `worktree` and `targetAcceptance` are inherited from the referenced request contract, the custom type cannot create incompatible combinations such as an `execute_plan` request shape with `audit` target rules.

8. Performance
Catalog construction should happen once per process start and once per `sync-skills` invocation. The resolved catalog should then be reused for subsequent requests in that process. Do not re-read custom prompt files on every request after startup validation unless the existing built-in loader already re-reads on first use; caching semantics should remain aligned with the current loader.

### Failure handling

- Invalid config shape: config load fails with a structured error that points to `customTypes` and the offending field path. The server does not start.
- Duplicate or colliding type name: startup fails with `custom_type_duplicate` or `custom_type_name_collision` and includes the conflicting name.
- Unsupported `requestContract`: startup fails with `custom_type_invalid_contract`.
- Missing or unreadable skill file: startup fails with `custom_type_skill_missing` or `custom_type_skill_unreadable` and includes the resolved file path.
- Unknown request type at runtime: the unified handler returns `400 invalid_request` with a field-level error or `unknown_task_type` detail rather than falling through to a generic exception.
- Missing config during `sync-skills`: built-in skill syncing proceeds exactly as today; custom skills are omitted because there is no registration source.
- Empty `customTypes`: the resolved catalog equals the built-in catalog; no behavior changes.

### Impact

Breaking changes:
- Internal only: modules that currently import `TASK_TYPES`, `TYPE_REGISTRY`, or `taskInputSchema` as closed constants will need to use the new catalog or contract helpers.

Non-breaking external behavior:
- Existing request shapes, built-in type names, and pipeline semantics remain unchanged.
- Existing configs without `customTypes` continue to parse and run.

Migration path:
1. Add `customTypes` to config.
2. Place implementer, reviewer, and caller skill files on disk.
3. Restart `mma serve`.
4. Run `mma sync-skills` to install the caller-facing custom skills into clients.

Rollout plan:
1. Land the catalog refactor and config schema support.
2. Add startup validation and custom skill loading.
3. Extend `sync-skills`.
4. Ship tests for parity and failure modes.

## Testing Plan

### Test strategy
Prove that custom task types are configuration-only aliases over the existing MMA task system: they should validate through the same Zod contracts, resolve their own prompt files, dispatch through the same two-phase pipeline, obey configured sandbox policies, and appear in the caller skill installation surface. Tests must also prove that invalid registrations fail before runtime traffic begins.

### Technical details

| Layer | What is tested | Tool | Coverage target |
|---|---|---|---|
| Unit | `customTypeSchema`, name validation, enum validation, path resolution, collision detection | Vitest | `100%` of branch logic in catalog builder |
| Unit | Request-contract reuse parity between built-in schema and custom alias | Vitest | At least one pass case and one fail case per supported alias path used in tests |
| Unit | Custom skill loader reads configured implement/review files | Vitest | `100%` of custom loader branches |
| Unit | `sync-skills` source expansion includes custom caller skills in text and JSON output | Vitest | All output modes exercised |
| Integration | Unified task handler accepts a registered custom type and calls the two-phase pipeline with the configured sandbox and tiers | Vitest with handler deps fakes | One success case and one unknown-type failure case |
| Integration | Server startup fails closed on invalid custom registration | Vitest | One test per startup failure class |
| Regression | Built-in task behavior is unchanged when `customTypes` is absent | Existing unified tests plus new regression assertions | Preserve current green suite |

## Acceptance Criteria

1. [ ] AC-1.1: A config file containing a valid `customTypes[]` entry with `name`, `requestContract`, `defaultTier`, `sandbox`, and all three `skillPaths` parses successfully through the config loader.
2. [ ] AC-1.2: A config file whose custom type name collides with any built-in task type is rejected before server startup with a clear collision error naming the offending type.
3. [ ] AC-1.3: A config file containing duplicate custom type names is rejected before server startup with a clear duplicate-name error.
4. [ ] AC-1.4: A config file whose custom type references an unsupported `requestContract` is rejected before server startup with a clear contract error.
5. [ ] AC-1.5: A config file whose custom type points to a missing or unreadable `implement`, `review`, or `caller` skill file is rejected before server startup with a clear file-path error.
6. [ ] AC-1.6: Startup validation errors for invalid custom types include a structured error message with an error code (e.g., `custom_type_name_collision`), the offending custom type name, and the specific invalid field or file path, enabling fast operator correction.
7. [ ] AC-2.1: A valid custom task type is present in the resolved runtime catalog and can be looked up by its configured name.
8. [ ] AC-2.2: A request sent to `POST /task` with a registered custom type is validated by the same Zod request contract object used by its referenced built-in `requestContract`.
9. [ ] AC-2.3: A valid request for a registered custom type dispatches through the existing two-phase pipeline using the configured `defaultTier`, the derived reviewer tier, and the configured `sandbox`.
10. [ ] AC-2.4: The pipeline loads the registered custom type’s configured implementer and reviewer prompt files rather than the bundled `packages/core/src/skills/<type>` path.
11. [ ] AC-2.5: A request whose `type` is neither built-in nor registered custom is rejected deterministically as an unknown task type.
12. [ ] AC-3.1: Running `mma sync-skills` with a successfully loaded config includes one caller-facing custom skill named `mma-<customTypeName>` per registered custom type.
13. [ ] AC-3.2: The `mma sync-skills --json` output includes custom skills with enough metadata to distinguish them from built-ins.
14. [ ] AC-3.3: Built-in task handling and built-in skill sync behavior are unchanged when `customTypes` is absent or empty.
15. [ ] AC-3.4: Registration of up to `25` custom types completes within `100 ms` at startup on local disk in automated measurement.
