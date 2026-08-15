// ExecutionRuntime — the application layer between transport adapters and the
// core two-phase pipeline. Adapters (REST today; future protocols) validate
// their wire input into a TaskInput, build a CallerContext at their boundary,
// and call submit(). Everything downstream of validation — tier resolution,
// skill loading, project reservation, per-type preprocessing, pipeline
// invocation, terminal envelope construction, telemetry — lives here and never
// touches a transport request object.

import { randomUUID } from 'node:crypto';
import { bucketActivity } from './task-identity.js';
import {
  getTypeConfig,
  oppositeAgent,
  loadSkill,
  loadMethodGuidance,
  resolveAgent,
  runTwoPhasePipeline,
  UnknownMethodError,
  type SkillPair,
  type TaskInput,
  type RunnableConfig,
  type AgentType,
  type ExecutionRegistry,
  type ProjectContext,
  type ResolvedAgent,
  type Initiative,
  type Task,
} from '@zhixuan92/multi-model-agent-core';
import { resolveRateCard, priceTokens } from '@zhixuan92/multi-model-agent-core/bounded-execution/cost-compute';
import type { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import { attachHeadlineProducer } from './headline-from-events.js';
import type { CallerContext } from './caller-context.js';
import { ExecutionScope } from './execution-scope.js';
import type { ExecutionStore } from './execution-store.js';
import type { InitiativeLinker } from './initiative-linker.js';
import type { InitiativeRecordRuntime } from './initiative-record-runtime.js';
import type { ProjectRegistry } from './project-registry.js';
import type { ExecutionEntry } from '@zhixuan92/multi-model-agent-core';
import { SKILLS_DIR } from './skills-dir.js';
import { buildGoalCondition } from './goal-conditions.js';
import { buildErrorEnvelope, tryParseJson } from './result-shape.js';
import { buildEnvelopeSnapshot } from './telemetry-snapshot.js';
import { PREPROCESSORS, PreprocessFailure, type PreprocessResult } from './preprocessors/index.js';

interface ExecutionRuntimeDeps {
  /** Narrowed at daemon start by `assertRunnable`: the runtime cannot
   *  resolve a tier without one, so it takes a config that provably has them. */
  config: RunnableConfig;
  bus: EnvelopeBus;
  executionRegistry: ExecutionRegistry;
  projectRegistry: ProjectRegistry;
  /** Durable execution records — admission is persisted before the handle is
   *  returned; terminal transitions mirror the in-memory registry. */
  store: ExecutionStore;
  /** Outbox consumer for a linked Execution's terminal result (SPEC-003 Task I-5). Invoked
   *  after every terminal store write below — optional so every existing unlinked-execution
   *  call site (and every test that never admits a linkage) keeps working unchanged; an
   *  execution with no `ExecutionLinkage` never produces an outbox row to replay anyway. */
  initiativeLinker?: InitiativeLinker;
  /** Shared Initiative Record application service (SPEC-003 Task I-6) — resolves the linked
   *  Initiative/Task and performs the pre-admission Task transition for a request carrying
   *  `input.initiative`. Optional so every existing unlinked-only `ExecutionRuntime`
   *  construction (most unit tests, which never set `input.initiative`) keeps working
   *  unchanged; a linked request against a runtime with none wired is rejected as an invalid
   *  linked request before any handle or session is created — see `admitLinkedTask` below. */
  initiativeRuntime?: InitiativeRecordRuntime;
  /** Injectable agent resolver — tests substitute mock providers; production
   *  uses the config-driven resolveAgent (same pattern as PipelineInput's
   *  runAcceptanceCommand). */
  resolveAgentFn?: (tier: AgentType, config: RunnableConfig) => ResolvedAgent;
}

export type SubmitError =
  | { kind: 'agent_not_configured'; message: string }
  | { kind: 'skill_load_failed'; message: string }
  | { kind: 'project_reservation'; code: string; message: string }
  /** The in-memory registry and durable execution store could not both admit the execution.
   *  In particular, a linked Task has NOT been transitioned when this is returned. */
  | { kind: 'execution_admission'; code: 'execution_admission_failed'; message: string }
  /** SPEC-003 Task I-6 linked-admission rejection. `code` is one of the three typed Initiative
   *  errors the Contract names: unknown Initiative / malformed membership / absent
   *  authorization all surface as `invalid_request`; a Task outside `open | claimed` surfaces
   *  as `invalid_task_transition`; a claimed Task with a mismatched `authorized_by` surfaces
   *  as `task_claim_conflict`. Every one of these returns before any execution handle,
   *  provider session, Task mutation, or outbox row exists. */
  | { kind: 'linked_admission'; code: 'invalid_request' | 'invalid_task_transition' | 'task_claim_conflict'; message: string }
  /** SPEC-005 Task I-4: an explicit, syntactically-valid request `method` does not name a
   *  registered Method. Returned AFTER linked-Task validation succeeds (a bad linked Task
   *  wins first) and BEFORE skill loading, prompt construction, pipeline start,
   *  `ExecutionRegistry.register()`, `ExecutionStore.admit()`, or outbox writing — the same
   *  no-durable-write-on-the-wrong-side guarantee `linked_admission` already holds. A
   *  malformed `method` (wrong shape) never reaches here — `taskInputSchema` rejects it as
   *  `invalid_request` at the wire boundary, before `submit()` runs at all. */
  | { kind: 'unknown_method'; message: string };

/** The `input.initiative` shape `taskInputSchema` validates (SPEC-003 Task I-6) — structurally
 *  identical to `ExecutionLinkage` (`execution-store.ts`) and the outbox's own
 *  `linkagePayloadSchema` (`initiative-linker.ts`), so a validated linkage flows to
 *  `ExecutionStore.admit()`'s fifth argument without a cast. `task_uuid` is OPTIONAL (frozen
 *  interface, AC-1.1): its absence marks Initiative-only linkage — see `admitLinkedTask` below. */
interface LinkedAdmissionInput {
  initiative: { uuid: string } | { human_key: string };
  task_uuid?: string;
  authorized_by: string;
}

/** The `initiative` linkage a task input carries, or `undefined`. Only present when the caller
 *  explicitly opted into linked admission — the schema field is optional on every task type. */
function linkageOf(input: TaskInput): LinkedAdmissionInput | undefined {
  return (input as Record<string, unknown>).initiative as LinkedAdmissionInput | undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type SubmitResult =
  | { ok: true; executionId: string }
  | { ok: false; error: SubmitError };

type CancelResult =
  | { outcome: 'not_found' }
  | { outcome: 'terminal'; entry: ExecutionEntry }
  | { outcome: 'requested'; entry: ExecutionEntry };

/**
 * The `subtype` a task input carries, or `null`.
 *
 * Only `audit` declares one, and the input schema is strict, so no other type can
 * smuggle one in. A single reader looks like ceremony against that — until you
 * notice this field was being extracted in three places under three different
 * rules: an unchecked cast on the way into skill loading, a typeof check on the
 * way into the task registry, and a truthiness check gated on `type === 'audit'`
 * on the way into the terminal envelope. They agree today by coincidence. One
 * reader is what makes a running audit and a finished audit describe themselves
 * identically by construction, on the day a second type gains a subtype.
 */
function subtypeOf(input: TaskInput): string | null {
  const value = (input as Record<string, unknown>).subtype;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The explicit request `method` a task input carries, or `null` (SPEC-005).
 *
 * Every one of the twelve `TASK_TYPES` arms accepts `method?: string` (shared
 * `commonFields`), and `taskInputSchema` already rejects a malformed value at the wire
 * boundary — what reaches here is always `undefined` or a syntactically valid identifier.
 * Read the same way `subtypeOf` reads its field, for the same reason: one
 * reader, so resolution, the running registry, and the terminal envelope never disagree
 * about what the caller asked for.
 */
function methodOf(input: TaskInput): string | null {
  const value = (input as Record<string, unknown>).method;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Resolved Method precedence + guidance for one submission (SPEC-005 Task I-4, AC-1.7/AC-1.8). */
type MethodResolution =
  | { ok: true; methodId: string | null; guidance: string | null }
  | { ok: false; error: SubmitError };

export class ExecutionRuntime {
  /** Live abort channels, keyed by executionId. An entry exists from admission until
   *  the execution's finally block — cancel() fires the scope's signal, the
   *  provider guards terminate the worker process group, and the terminal CAS
   *  decides between cancelled and a completed/failed that won the race. */
  private readonly liveScopes = new Map<string, ExecutionScope>();

  /** Detach the running-headline producer. Held so tests can subscribe/unsubscribe cleanly. */
  private readonly detachHeadlines: () => void;

  constructor(private readonly deps: ExecutionRuntimeDeps) {
    // Populate `runningHeadline` from provider activity. Until this existed the field was
    // readable on both wires and written by nothing, so every progress view showed a phase
    // name and a clock and nothing about what the worker was actually doing.
    this.detachHeadlines = attachHeadlineProducer(deps.bus, deps.executionRegistry);
  }

  /** Release the bus subscription. */
  close(): void {
    this.detachHeadlines();
  }

  /** Best-effort outbox replay after a terminal store write (SPEC-003 Task I-5). Swallows any
   *  throw — `InitiativeLinker.replayOutbox()` already catches per-row failures internally, so
   *  reaching a throw here means something unexpected (e.g. a closed store); an execution's own
   *  terminal result must never be lost or a task destabilized over a downstream Initiative
   *  write. */
  private replayLinkage(): void {
    try {
      this.deps.initiativeLinker?.replayOutbox();
    } catch (err) {
      process.stderr.write(
        `[mma] event=initiative_link_replay_error ts=${new Date().toISOString()} err="${(err instanceof Error ? err.message : String(err)).replace(/"/g, '\\"')}"\n`,
      );
    }
  }

  /**
   * Linked-admission READ-ONLY validation phase (SPEC-003 B6 round-2 defect A). Resolves the
   * selected Initiative and — when `linkage.task_uuid` is present — the named Task: checks Task
   * membership (the Task must belong to the resolved Initiative), checks Task state (`open |
   * claimed` only — deliberately narrower than the store's own FR-9 transition matrix, which
   * would separately permit e.g. `blocked -> in_progress`: only `open` and `claimed` are valid
   * LINKED-ADMISSION starting states), and checks claim ownership for a claimed Task. Issues NO
   * writes — every call here is a read (`initiative_get` / `initiative_task_get`).
   *
   * Runs BEFORE `executionRegistry.register` / `store.admit` in `submit()` below, so every
   * rejection here (unknown Initiative, unknown/foreign Task, invalid status, claim conflict)
   * returns before any execution handle, provider session, or outbox row exists (AC-1.9,
   * AC-1.10). A prior version of this method ran its Task-transition WRITE inline with these
   * checks, downstream of admission — every rejection was still detected correctly, but by then
   * `register`/`admit` had already run, so every rejected linked admission durably created a
   * FAILED execution row nothing ever needed.
   *
   * `task_uuid` is OPTIONAL (frozen interface, AC-1.1). When omitted this is Initiative-only
   * linkage: only the Initiative selector above is validated, and this returns `{ ok: true, task:
   * null }` — there is no Task to check membership/state/ownership against.
   */
  private validateLinkedTask(linkage: LinkedAdmissionInput): { ok: true; task: Task | null } | { ok: false; error: SubmitError } {
    const runtime = this.deps.initiativeRuntime;
    if (!runtime) {
      return {
        ok: false,
        error: { kind: 'linked_admission', code: 'invalid_request', message: 'Linked admission is unavailable: no Initiative Record runtime configured' },
      };
    }

    let initiative: Initiative;
    try {
      initiative = runtime.execute({ operation: 'initiative_get', input: linkage.initiative }) as Initiative;
    } catch (err) {
      return { ok: false, error: { kind: 'linked_admission', code: 'invalid_request', message: `Unknown Initiative: ${errMessage(err)}` } };
    }

    const taskUuid = linkage.task_uuid;
    if (taskUuid === undefined) {
      // Initiative-only linkage: the Initiative selector alone validated above is the whole
      // check. No Task exists yet to register execution-result Evidence against or transition —
      // `InitiativeLinker.replayInitiativeOnlyRow` records Evidence directly against the
      // Initiative once this execution reaches a terminal state.
      return { ok: true, task: null };
    }

    let task: Task;
    try {
      task = runtime.execute({ operation: 'initiative_task_get', input: { uuid: taskUuid } }) as Task;
    } catch (err) {
      return { ok: false, error: { kind: 'linked_admission', code: 'invalid_request', message: `Unknown Task: ${errMessage(err)}` } };
    }

    if (task.initiative_id !== initiative.uuid) {
      return {
        ok: false,
        error: { kind: 'linked_admission', code: 'invalid_request', message: `Task ${task.uuid} does not belong to Initiative ${initiative.uuid}` },
      };
    }

    if (task.status !== 'open' && task.status !== 'claimed') {
      return {
        ok: false,
        error: { kind: 'linked_admission', code: 'invalid_task_transition', message: `Task ${task.uuid} cannot start a linked execution from status '${task.status}'` },
      };
    }

    if (task.status === 'claimed' && task.claimed_by !== linkage.authorized_by) {
      return {
        ok: false,
        error: { kind: 'linked_admission', code: 'task_claim_conflict', message: `Task ${task.uuid} is claimed by ${JSON.stringify(task.claimed_by)}, not ${linkage.authorized_by}` },
      };
    }

    return { ok: true, task };
  }

  /**
   * Method resolution + guidance load (SPEC-005 Task I-4, AC-1.7/AC-1.8). Runs AFTER
   * `validateLinkedTask` succeeds (a bad linked Task wins first — see the Errors contract) and
   * BEFORE skill loading, prompt construction, pipeline start, `ExecutionRegistry.register()`,
   * `ExecutionStore.admit()`, or outbox writing. Precedence: a non-null explicit request
   * `method` wins; otherwise the linked Task's stored `method`; otherwise `null`. `null`
   * resolves trivially — no store lookup, no guidance load, no prompt injection — which is
   * what keeps a Method-less generic prompt byte-identical to the pre-Method baseline.
   *
   * A resolved, non-null identifier must be a REGISTERED Method (`UnknownMethodError` maps to
   * `unknown_method`) with a committed guidance asset (a resolver failure maps to
   * `skill_load_failed` — the contract's "fails cleanly ... never falls back to a route
   * asset"). `taskInputSchema` already rejected a malformed `method` shape at the wire
   * boundary, so the only failure reachable here for a syntactically valid identifier is
   * "not registered" or "no committed guidance."
   */
  private resolveMethod(input: TaskInput, linkedTask: Task | null): MethodResolution {
    const requested = methodOf(input);
    const effective = requested ?? linkedTask?.method ?? null;
    if (effective === null) return { ok: true, methodId: null, guidance: null };

    const runtime = this.deps.initiativeRuntime;
    if (!runtime) {
      return {
        ok: false,
        error: { kind: 'unknown_method', message: `Method resolution is unavailable: no Initiative Record runtime configured` },
      };
    }

    try {
      runtime.execute({ operation: 'method_get', input: { id: effective } });
    } catch (err) {
      if (err instanceof UnknownMethodError) {
        return { ok: false, error: { kind: 'unknown_method', message: err.message } };
      }
      throw err;
    }

    let guidance: string;
    try {
      guidance = loadMethodGuidance(effective);
    } catch (err) {
      return { ok: false, error: { kind: 'skill_load_failed', message: `Method guidance load failed for '${effective}': ${errMessage(err)}` } };
    }

    return { ok: true, methodId: effective, guidance };
  }

  /**
   * Linked-admission MUTATION phase (SPEC-003 B6 round-2 defect A). Performs the Task's
   * `open|claimed -> in_progress` transition with `execution_ref: executionId` and system
   * provenance — the ONE write `validateLinkedTask` above deliberately does not make. Called from
   * `submit()` only after `executionRegistry.register` / `store.admit` (with linkage already
   * durably attached to the pending row — SPEC-003 B6 round-2 defect B, Option 1) have both
   * succeeded, so a failure here fails the already-real execution handle as a unit rather than
   * leaving anything on the Task side to compensate (the transition itself never landed).
   *
   * `task` is the exact value `validateLinkedTask` resolved moments earlier in the same
   * `submit()` call — re-reading it here would reopen the staleness window
   * `expected_revision`/claim-ownership checking exists to catch, for a gap this method exists
   * specifically to keep as small as one durable write.
   */
  private commitLinkedTask(executionId: string, linkage: LinkedAdmissionInput, task: Task): { ok: true } | { ok: false; error: SubmitError } {
    try {
      // Non-null: `commitLinkedTask` is only ever called with a `task` that `validateLinkedTask`
      // resolved, which requires `this.deps.initiativeRuntime` to already be defined.
      this.deps.initiativeRuntime!.execute({
        operation: 'initiative_task_execution',
        input: { uuid: task.uuid, execution_ref: executionId, transition: 'in_progress' },
        expected_revision: task.revision,
        idempotency_key: `admission:${executionId}`,
        provenance: {
          actor_type: 'system',
          actor_id: 'engine:execution',
          interface: 'system',
          initiated_by: executionId,
          authorized_by: linkage.authorized_by,
          timestamp: new Date().toISOString(),
          source: 'execution_admission',
        },
      });
    } catch (err) {
      return { ok: false, error: { kind: 'linked_admission', code: 'invalid_request', message: `Linked admission transition failed: ${errMessage(err)}` } };
    }

    return { ok: true };
  }

  /**
   * Request cooperative cancellation. 202-semantics: 'requested' means the
   * abort channel fired, not that the work already stopped — the task stays
   * `pending` (with cancellationRequestedAt set) until the runner confirms
   * termination, then transitions to `cancelled` unless completion won the
   * race. Idempotent; terminal tasks report 'terminal' with their final entry.
   */
  cancel(executionId: string): CancelResult {
    const res = this.deps.executionRegistry.requestCancel(executionId);
    if (res.outcome === 'not_found') return { outcome: 'not_found' };
    if (res.outcome === 'terminal') return { outcome: 'terminal', entry: res.entry! };
    this.deps.store.requestCancel(executionId);
    this.liveScopes.get(executionId)?.abort('cancel requested by caller');
    return { outcome: 'requested', entry: res.entry! };
  }

  /**
   * Synchronous admission: resolve tiers/agents/skills, reserve the project,
   * register the task, and schedule the async execution. Returns the executionId the
   * adapter surfaces to the caller; the execution result arrives via polling.
   */
  async submit(input: TaskInput, caller: CallerContext): Promise<SubmitResult> {
    const { deps } = this;
    const cwd = caller.projectRoot;

    const typeConfig = getTypeConfig(input.type);
    // Read directly off the union, not through `input as Record<string, unknown>` and a second
    // cast to AgentType. Every arm carries `agentTier?` from `commonFields` and the schema
    // validates it as an enum, so the casts bridged nothing while telling the compiler to stop
    // checking the one thing worth checking here — that the value really is a tier.
    const implTier = input.agentTier ?? typeConfig.defaultTier;
    const revTier = oppositeAgent(implTier);
    // execute_plan is always reviewed: contract-first completion scoring derives
    // contract satisfaction from the reviewer's tasks[], so an unreviewed execute-plan
    // has no scoring source. This overrides any caller-requested 'none'.
    const reviewPolicy = input.type === 'orchestrate'
      ? 'none'
      : input.type === 'execute_plan'
        ? 'reviewed'
        : (input.reviewPolicy ?? 'reviewed');
    // Raw caller intent: undefined when omitted. Journal routes force review only when the
    // caller explicitly asked for it; otherwise the deterministic invariants decide.
    const callerForcedReview = input.reviewPolicy === 'reviewed';

    // SPEC-003 B6 round-2 defect A: linked-admission validation runs as a PURE READ-ONLY phase
    // — `validateLinkedTask` — BEFORE the execution handle exists at all. A prior version ran
    // that validation together with the Task-transition WRITE, downstream of
    // `executionRegistry.register` / `store.admit`: every rejection (task_claim_conflict /
    // invalid_task_transition / invalid_request) was still detected correctly, but only after a
    // durable FAILED execution row had already been created for it — violating AC-1.9/AC-1.10
    // ("No execution handle, provider session, or outbox row is created"). Validating first means
    // a rejection here returns before register/admit ever runs.
    //
    // SPEC-005 Task I-4: this now ALSO runs before agent resolution, skill loading, and Method
    // resolution — moved up from its previous position (after skill loading) so that a bad
    // linked Task rejects before every one of those downstream side effects too, per the
    // Architecture contract ("first validates a linked Task, then resolves ... Method, then
    // loads generic route skills and Method guidance").
    const linkage = linkageOf(input);
    let linkedTask: Task | null = null;
    if (linkage) {
      const validated = this.validateLinkedTask(linkage);
      if (!validated.ok) return validated;
      linkedTask = validated.task;
    }

    // SPEC-005 Task I-4 (AC-1.7/AC-1.8): resolve the effective Method (explicit request, else
    // the linked Task's, else null) and load its committed guidance — AFTER linked-Task
    // validation, BEFORE skill loading, prompt construction, pipeline start,
    // `ExecutionRegistry.register()`, `ExecutionStore.admit()`, or outbox writing. An unknown
    // explicit Method rejects here, before any of those.
    const methodResolution = this.resolveMethod(input, linkedTask);
    if (!methodResolution.ok) return methodResolution;
    const { methodId: resolvedMethodId, guidance: methodGuidance } = methodResolution;

    const resolve = deps.resolveAgentFn ?? resolveAgent;
    let implAgent: ResolvedAgent, revAgent: ResolvedAgent;
    try {
      implAgent = resolve(implTier, deps.config);
      revAgent = resolve(revTier, deps.config);
    } catch (err) {
      return { ok: false, error: { kind: 'agent_not_configured', message: err instanceof Error ? err.message : 'Agent resolution failed' } };
    }

    let skills: SkillPair;
    try {
      skills = await loadSkill(input.type, SKILLS_DIR, subtypeOf(input) ?? undefined);
    } catch (err) {
      return { ok: false, error: { kind: 'skill_load_failed', message: err instanceof Error ? err.message : 'Skill load failed' } };
    }

    const reserveResult = deps.projectRegistry.reserveProject(cwd);
    if (!reserveResult.ok) {
      return { ok: false, error: { kind: 'project_reservation', code: reserveResult.error, message: reserveResult.message } };
    }
    const pc = reserveResult.projectContext;
    pc.lastActivityAt = Date.now();

    // Registering first (rather than running the Task transition first) sidesteps the ownership
    // question a failed register/admit would otherwise raise: compensating a stranded
    // `in_progress` Task means an `initiative_task_release`, which FR-9 gates on claimant
    // ownership (a system-actor release can itself throw `task_claim_conflict`, compounding the
    // failure). Registering first means nothing ever mutates `initiatives.db` until the handle
    // already durably exists, so a Task-transition failure below has nothing on the Task side to
    // undo — it only needs to fail the (already-real) handle as a unit.
    const executionId = randomUUID();

    // Register task in ExecutionRegistry AND persist the admission record — a
    // handle that exists is always a handle that survives a restart. Linkage (when present) is
    // attached in THIS SAME `admit()` call — SPEC-003 B6 round-2 defect B, Option 1 — rather than
    // after the Task transition below succeeds. Attaching it only on transition success left a
    // crash window: the Task transition lands in `initiatives.db` (now `in_progress`), the daemon
    // dies before the follow-up attach call lands in `executions.db`, and `terminalize()`'s outbox
    // insert — gated on `linkage_json` — never fires, so the linker never reopens the stranded
    // Task (no manual-intervention state is acceptable here). Attaching linkage here instead means
    // EVERY crash from this point forward — before, during, or after the Task transition below —
    // funnels through the normal `interrupted -> terminalize -> outbox -> linker` path. This does
    // mean a validated-but-not-yet-applied linkage can reach the outbox before its Task transition
    // ever ran (e.g. the transition call below throws, or the process dies before it runs at all);
    // `InitiativeLinker`'s replay is made tolerant of exactly that (see `initiative-linker.ts`).
    try {
      deps.executionRegistry.register(executionId, cwd, input.type, subtypeOf(input), resolvedMethodId);
      deps.store.admit(executionId, input.type, cwd, process.pid, linkage, resolvedMethodId);
    } catch (err) {
      // The Task transition has not run yet (validation only reads `initiatives.db`) — nothing on
      // the Task side to compensate.
      const error: SubmitError = {
        kind: 'execution_admission',
        code: 'execution_admission_failed',
        message: `Execution admission failed${linkage ? '; linked Task was not transitioned' : ''}: ${errMessage(err)}`,
      };
      const envelope = buildErrorEnvelope(executionId, input.type, { code: error.code, message: error.message }, 'failed', resolvedMethodId);
      deps.executionRegistry.fail(executionId, envelope);
      return { ok: false, error };
    }

    if (linkage && linkedTask) {
      const committed = this.commitLinkedTask(executionId, linkage, linkedTask);
      if (!committed.ok) {
        // The execution handle already exists (with linkage already durable) — fail it as a
        // unit rather than leaving a `pending` row nothing will ever terminalize. The caller
        // never receives this executionId (this method returns the typed error below, not
        // `{ ok: true }`), so nothing outside this function can observe the row before it
        // reaches a terminal state. Linkage was already attached above, so this terminal write
        // still produces an outbox row — `InitiativeLinker` replays it tolerantly (nothing on the
        // Task side ever changed), so replay promptly rather than leaving it for the next
        // unrelated terminal write or a restart to pick up.
        const code = committed.error.kind === 'linked_admission' ? committed.error.code : 'linked_admission_failed';
        const envelope = buildErrorEnvelope(executionId, input.type, { code, message: committed.error.message }, 'failed', resolvedMethodId);
        deps.executionRegistry.fail(executionId, envelope);
        deps.store.fail(executionId, JSON.stringify(envelope));
        this.replayLinkage();
        return committed;
      }
    }

    // The scope (the live abort channel) is created here, after admission is durable and
    // linked, so a cancel that lands before the async executor starts still aborts the execution.
    const scope = new ExecutionScope(executionId);
    this.liveScopes.set(executionId, scope);

    // Emit task-created diagnostic for observability.
    // `task_id` / `tool`, matching the three sibling lifecycle events (`batch_completed`,
    // `batch_failed`, `batch_cancelled`) rather than this one's own `batch_id` / `route`. One
    // concept spelled two ways across four events emitted by one class is why `mma logs --batch`
    // has to match four different key forms to find a single task's diagnostics. Neither field
    // name is pinned by the observability golden (the event KINDS are), and nothing reads
    // `batch_id` or a plain entry's `route`.
    deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_created', fields: { task_id: executionId, tool: input.type } });

    // Run the pipeline asynchronously via setImmediate.
    const startedAtMs = Date.now();
    setImmediate(() => {
      void this.execute({
        executionId, input, caller, cwd, pc, skills, scope,
        implAgent, revAgent, implTier, revTier,
        reviewPolicy, callerForcedReview, startedAtMs,
        writeRoute: typeConfig.writeRoute,
        sandbox: typeConfig.sandbox,
        readerFacing: typeConfig.readerFacing,
        method: resolvedMethodId,
        methodGuidance,
      });
    });

    return { ok: true, executionId };
  }

  private async execute(run: {
    executionId: string;
    input: TaskInput;
    caller: CallerContext;
    cwd: string;
    pc: ProjectContext;
    skills: SkillPair;
    /** Created at admission (before preprocessing): every provider session this
     *  execution opens receives scope.signal, and every acquired resource
     *  registers its release here — drained in the finally so a crashing
     *  pipeline can never leak a pin. */
    scope: ExecutionScope;
    implAgent: ResolvedAgent;
    revAgent: ResolvedAgent;
    implTier: AgentType;
    revTier: AgentType;
    reviewPolicy: 'reviewed' | 'none';
    callerForcedReview: boolean;
    startedAtMs: number;
    writeRoute: boolean;
    sandbox: 'read-only' | 'cwd-only';
    readerFacing: boolean;
    /** The resolved Method identifier (SPEC-005), or `null`. Recorded verbatim into the
     *  terminal `execution` envelope — ALWAYS present there as `string | null`, never
     *  omitted, unlike `subtype`. */
    method: string | null;
    /** Committed guidance for `method`, or `null` when no Method resolved. Passed straight
     *  through to `runTwoPhasePipeline`, which injects it as one identical block into both
     *  worker prompts. */
    methodGuidance: string | null;
  }): Promise<void> {
    const { deps } = this;
    const {
      executionId, input, caller, cwd, pc, scope, implAgent, revAgent,
      implTier, revTier, reviewPolicy, callerForcedReview, startedAtMs,
    } = run;
    let { skills } = run;
    const contextBlockStore = pc.contextBlocks;
    const sessionIds = input.sessionIds;
    const { type: _type, agentTier: _tier, reviewPolicy: _review, sessionIds: _sessions, contextBlockIds: _blocks, initiative: _initiative, method: _method, ...payload } = input as Record<string, unknown>;

    // Terminal cancelled path — shared by the pre-start check, the pipeline
    // aborted mapping, and the crash path when the abort raced an error.
    const finishCancelled = (durationMs: number, envelope: Record<string, unknown>) => {
      deps.executionRegistry.cancel(executionId, envelope);
      deps.store.cancel(executionId, JSON.stringify(envelope));
      this.replayLinkage();
      deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_cancelled', fields: { task_id: executionId, tool: input.type, duration_ms: durationMs } });
      process.stderr.write(
        `[mma] event=task_cancelled ts=${new Date().toISOString()} task=${executionId} route=${input.type} duration_ms=${durationMs}\n`,
      );
    };

    try {
      // Cancelled before the executor even started (cancel raced setImmediate):
      // finish immediately with zero provider sessions.
      if (scope.signal.aborted) {
        finishCancelled(0, buildErrorEnvelope(executionId, input.type, { code: 'aborted', message: 'Execution cancelled by caller before it started' }, 'cancelled', run.method));
        return;
      }
      process.stderr.write(
        `[mma] event=executor_started ts=${new Date().toISOString()} task=${executionId} route=${input.type}\n`,
      );
      const implementerGoal = buildGoalCondition(input.type, 'implementer', skills.implement);
      const reviewerGoal = buildGoalCondition(input.type, 'reviewer', skills.review);

      // ── Per-type pre-processing (execute_plan contract parse, journal candidate
      //    injection, spec/plan outputPath validation, research evidence).
      //    A PreprocessFailure fails the task terminally with zero provider
      //    sessions opened — the client learns of it by polling. ──
      let pre: PreprocessResult = {};
      const preprocessor = PREPROCESSORS[input.type];
      if (preprocessor) {
        try {
          pre = await preprocessor({
            // The preprocessor and pipeline model per-work-unit identity as a core
            // task field; the execution-facing runtime never exposes that alias.
            taskId: executionId, cwd, payload, input, skills,
            signal: scope.signal,
            config: deps.config,
            implementerProvider: implAgent.provider,
          });
        } catch (err) {
          if (err instanceof PreprocessFailure) {
            const envelope = buildErrorEnvelope(executionId, input.type, { code: err.code, message: err.message }, 'failed', run.method);
            deps.executionRegistry.fail(executionId, envelope);
            deps.store.fail(executionId, JSON.stringify(envelope));
            this.replayLinkage();
            return;
          }
          throw err;
        }
        if (pre.skills) skills = pre.skills;
        if (pre.totalTasks !== undefined) {
          const entry = deps.executionRegistry.get(executionId);
          if (entry) entry.totalTasks = pre.totalTasks;
        }
      }

      // ── Context block resolution: resolve IDs → content, pin for duration ──
      // Missing blocks are skipped (soft) — the in-memory store loses blocks
      // on server restart, and a stale block should not kill the task.
      const inputBlockIds = input.contextBlockIds ?? [];
      let resolvedContextBlocks: string[] | undefined;
      if (inputBlockIds.length > 0) {
        const blocks: string[] = [];
        for (const id of inputBlockIds) {
          const content = contextBlockStore.get(id);
          if (content === undefined) {
            process.stderr.write(`[mma] context_block_skipped id=${id} task=${executionId} reason=not_found\n`);
            continue;
          }
          blocks.push(content);
          contextBlockStore.pin(id);
          // Scope-registered so a crashing pipeline releases the pin too —
          // previously a runner crash left the block pinned forever (DELETE
          // /context-blocks/:id would 409 until server restart).
          scope.registerCleanup(() => contextBlockStore.unpin(id));
        }
        if (blocks.length > 0) resolvedContextBlocks = blocks;
      }

      const enrichedPayload = pre.payloadSuffix
        ? `${JSON.stringify(payload, null, 2)}${pre.payloadSuffix}`
        : JSON.stringify(payload, null, 2);

      const onPhaseChange = (phase: 'implementing' | 'reviewing') => {
        deps.executionRegistry.setPhase(executionId, phase);
      };

      const result = await runTwoPhasePipeline({
        type: input.type,
        readerFacing: run.readerFacing,
        implementerSkill: skills.implement,
        reviewerSkill: skills.review,
        abortSignal: scope.signal,
        taskPayload: enrichedPayload,
        implementerProvider: implAgent.provider,
        reviewerProvider: revAgent.provider,
        implementerTier: implTier,
        reviewerTier: revTier,
        reviewPolicy,
        cwd,
        sandboxPolicy: run.sandbox,
        // Write routes commit on the caller's already-checked-out branch. Git detection
        // happens in repo-commit (a `.git` entry check); a non-git target simply skips git.
        writeRoute: run.writeRoute,
        // `PipelineInput.taskId` is the core pipeline's per-work-unit field.
        // This execution handle is still named `executionId` everywhere at the
        // execution boundary.
        taskId: executionId,
        implementerGoal,
        reviewerGoal,
        bus: deps.bus,
        onPhaseChange,
        forceReview: callerForcedReview,
        methodGuidance: run.methodGuidance,
        ...(pre.applyDecisions && { applyDecisions: pre.applyDecisions }),
        ...(pre.dispatchedTasks && { dispatchedTasks: pre.dispatchedTasks }),
        ...(pre.dispatchedContractTasks && { dispatchedContractTasks: pre.dispatchedContractTasks }),
        ...(pre.acceptanceTestSnapshot && { acceptanceTestSnapshot: pre.acceptanceTestSnapshot }),
        ...(sessionIds?.implementer && { resumeImplementer: sessionIds.implementer }),
        ...(sessionIds?.reviewer && { resumeReviewer: sessionIds.reviewer }),
        ...(resolvedContextBlocks && { contextBlocks: resolvedContextBlocks }),
      });
      const durationMs = Date.now() - startedAtMs;

      // Auto-register a terminal context block for read-only routes
      // so callers can reference the output in subsequent dispatches (delta mode).
      // Uses the reviewer output (quality-gated) when available, falls back to implementer.
      let contextBlockId: string | null = null;
      const terminalContent = result.reviewerRaw ?? result.implementerOutput;
      if (run.sandbox === 'read-only' && terminalContent.trim().length > 0) {
        try {
          const block = contextBlockStore.register(terminalContent);
          contextBlockId = block.id;
        } catch { /* best-effort — store may be at capacity */ }
      }

      const totalActualCostUSD = result.cost.implementerUsd + (result.cost.reviewerUsd ?? 0);

      // Baseline = the configured main tier, never a worker tier. Guessing from
      // `agents[implTier]` priced a run against one of the models that had just
      // executed it, reporting a negative saving for runs that saved money.
      // Trade-off: one declared value per daemon; it cannot follow a /model switch.
      const mainModelId = deps.config.agents.main.model;
      const mainCard = resolveRateCard(mainModelId);
      const totalUsage = {
        inputTokens: result.implementerTurn.usage.inputTokens + (result.reviewerTurn?.usage.inputTokens ?? 0),
        outputTokens: result.implementerTurn.usage.outputTokens + (result.reviewerTurn?.usage.outputTokens ?? 0),
        cachedReadTokens: result.implementerTurn.usage.cachedReadTokens + (result.reviewerTurn?.usage.cachedReadTokens ?? 0),
        cachedNonReadTokens: result.implementerTurn.usage.cachedNonReadTokens + (result.reviewerTurn?.usage.cachedNonReadTokens ?? 0),
      };
      const mainEquivalentUSD = mainCard ? priceTokens(totalUsage, mainCard) : null;
      const costDeltaVsMain = mainEquivalentUSD !== null ? mainEquivalentUSD - totalActualCostUSD : null;

      // Cancellation mapping: an aborted pipeline surfaces as status 'failed'
      // with failureReason 'aborted'. When OUR scope fired the abort, the
      // terminal state is `cancelled` — the caller asked for this outcome, it
      // is not a failure. A pipeline that finished despite a late cancel won
      // the race and keeps its real status (first writer wins).
      const wasCancelled = result.status === 'failed' && scope.signal.aborted;

      const resultObj = {
        execution: {
          executionId: executionId,
          type: input.type,
          // No `type === 'audit'` gate: the strict input schema already limits
          // `subtype` to audit, so a type-based gate here would only restate the
          // schema while giving the terminal envelope a second rule the running
          // snapshot did not share.
          ...(subtypeOf(input) !== null ? { subtype: subtypeOf(input) } : {}),
          // Unlike `subtype`, ALWAYS present as `string | null` — never omitted.
          // Method resolution applies uniformly across every task type (SPEC-005), so a
          // consumer must be able to tell "resolved to null" from "field absent."
          method: run.method,
          status: wasCancelled ? ('cancelled' as const) : result.status,
          sessions: {
            implementer: result.sessions.implementer.sessionId,
            reviewer: result.sessions.reviewer?.sessionId ?? null,
          },
          // The run's activity shape, frozen at terminal. Carried in the envelope rather than
          // read live from the registry so a panel opened after the entry is evicted — or
          // after a daemon restart, from the durable store — still shows what the run did.
          ...(() => {
            const a = bucketActivity(deps.executionRegistry.get(executionId));
            return a ? { activity: a.counts, activityPhases: a.phases } : {};
          })(),
          // Permanently null: the engine no longer owns worktrees. Kept as a structural
          // response key so existing typed consumers stay compatible.
          worktree: null,
          dirtyAtDispatch: result.dirtyAtDispatch,
        },
        output: {
          // When the reviewer parsed cleanly, its refined structured output IS the answer.
          // When it didn't (reviewerOutput === null), fall straight to the implementer's
          // answer — never to result.reviewerTurn.output, which is the unparseable prose
          // that failed and would otherwise pollute summary.
          summary: result.reviewerOutput ?? tryParseJson(result.implementerOutput),
          // FR-3: for a git target this is `git diff --name-only <headBeforeDispatch>..HEAD`
          // — engine-measured, never the worker's self-report. Non-git targets have no git
          // evidence, so they keep the provider-reported list.
          filesChanged: result.filesChangedFromGit ?? result.implementerTurn.filesWritten,
          // SPEC-003 B6 defect 2 — the commit-time SHA, captured once by the pipeline when it
          // committed. `InitiativeLinker` reads this off the persisted terminal envelope at
          // replay time instead of re-deriving it from live git state, which would attribute a
          // LATER commit (landed after this execution, before replay) to this execution's work.
          commitSha: result.commitSha,
          ...(result.contractNote && { contractNote: result.contractNote }),
          contextBlockId,
          // Advisory: the reviewer ran but its output wasn't parseable, so the answer above
          // is the un-refined implementer output. This is a concern (status is already
          // done_with_concerns), NOT a fatal error — see the `error` field below.
          reviewerNote: result.reviewerParseError
            ? { code: 'reviewer_unavailable' as const, message: result.reviewerParseError }
            : null,
        },
        metrics: {
          totalDurationMs: durationMs,
          totalCostUsd: totalActualCostUSD,
          implementer: {
            durationMs: result.implementerTurn.durationMs,
            costUsd: result.cost.implementerUsd,
            usage: result.implementerTurn.usage,
          },
          reviewer: result.reviewerTurn ? {
            durationMs: result.reviewerTurn.durationMs,
            costUsd: result.cost.reviewerUsd!,
            usage: result.reviewerTurn.usage,
          } : null,
          totalUsage: totalUsage,
          mainEquivalentCostUsd: mainEquivalentUSD,
          savedVsMainCostUsd: costDeltaVsMain,
        },
        raw: {
          implementer: result.implementerOutput,
          reviewer: result.reviewerTurn?.output ?? null,
        },
        // Only a `failed` status is a fatal error. A reviewer that couldn't emit parseable
        // output is a concern, not a failure — the pipeline already downgraded it to
        // done_with_concerns and the implementer answer stands (surfaced in output.summary,
        // with the reason in output.reviewerNote). This mirrors the telemetry envelope's
        // structuredError, which is likewise null for done_with_concerns.
        error: result.status === 'failed'
          ? (result.failureReason ?? { code: 'pipeline_failed' as const, message: 'Pipeline completed with failed status' })
          : null,
      };

      // Emit telemetry via the bus — TelemetryUploader picks up the
      // sealed envelope snapshot and enqueues a wire record. A cancelled
      // execution rides as its raw pipeline status (wire schema v6 has no
      // cancelled state; the caller-initiated outcome lives in the task
      // envelope above, not the billing record).
      try {
        const implModelId = deps.config.agents[implTier]?.model ?? 'unknown';
        const revModelId = deps.config.agents[revTier]?.model ?? 'unknown';
        const envelope = buildEnvelopeSnapshot(
          executionId, input.type, result,
          implTier, revTier, reviewPolicy,
          implModelId, revModelId, mainModelId,
          caller.clientName,
          cwd, durationMs,
          pre.sourcesUsed ?? [],
        );
        deps.bus.emitEnvelopeSnapshot(envelope, 'seal');
      } catch (telErr) {
        process.stderr.write(
          `[mma] event=telemetry_emit_error ts=${new Date().toISOString()} task=${executionId} err="${(telErr instanceof Error ? telErr.message : String(telErr)).replace(/"/g, '\\"')}"\n`,
        );
      }

      if (wasCancelled) {
        finishCancelled(durationMs, resultObj);
      } else if (result.status === 'failed') {
        deps.executionRegistry.fail(executionId, resultObj);
        deps.store.fail(executionId, JSON.stringify(resultObj));
        this.replayLinkage();
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: executionId, tool: input.type, duration_ms: durationMs, error_code: result.failureReason?.code ?? 'pipeline_failed', error_message: result.failureReason?.message ?? 'Pipeline completed with failed status' } });
        process.stderr.write(
          `[mma] event=task_failed ts=${new Date().toISOString()} task=${executionId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      } else {
        deps.executionRegistry.complete(executionId, resultObj);
        deps.store.complete(executionId, JSON.stringify(resultObj));
        this.replayLinkage();
        deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_completed', fields: { task_id: executionId, tool: input.type, duration_ms: durationMs } });
        process.stderr.write(
          `[mma] event=task_completed ts=${new Date().toISOString()} task=${executionId} route=${input.type} duration_ms=${durationMs}\n`,
        );
      }
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      if (scope.signal.aborted) {
        // The abort raced an in-flight operation into an exception — the
        // caller's cancel is the real outcome, not a runner crash.
        finishCancelled(durationMs, buildErrorEnvelope(executionId, input.type, { code: 'aborted', message: 'Execution cancelled by caller' }, 'cancelled', run.method));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const errObj = {
        code: 'runner_crash',
        message,
        ...(stack !== undefined && { stack }),
      };
      const envelope = buildErrorEnvelope(executionId, input.type, errObj, 'failed', run.method);
      deps.executionRegistry.fail(executionId, envelope);
      deps.store.fail(executionId, JSON.stringify(envelope));
      this.replayLinkage();
      deps.bus.emitPlainEntry({ ts: new Date().toISOString(), kind: 'batch_failed', fields: { task_id: executionId, tool: input.type, duration_ms: durationMs, error_code: errObj.code, error_message: errObj.message } });
      process.stderr.write(
        `[mma] event=task_failed ts=${new Date().toISOString()} task=${executionId} route=${input.type} duration_ms=${durationMs} error="${message.replace(/"/g, '\\"')}"\n`,
      );
    } finally {
      this.liveScopes.delete(executionId);
      await scope.drain();
    }
  }
}
