import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The Deliverable Contract: the declared set of facts a caller and MMA agree on for one
 * solution — `kind`, `audience`, `artifacts`, `acceptance`, and `disposition` — and the
 * canonical digest that binds a human approval to that exact content.
 *
 * A contract EMERGES through three states, so its shape widens with its state:
 *  - `DraftContract` (exploration) — only `audience` is required.
 *  - `ProposedContract` (spec / plan) — `kind`, `artifacts`, `acceptance`, and
 *    `disposition` are required; every acceptance criterion carries an explicit
 *    verification `method`.
 *  - `ApprovedContract` (execution onward) — adds a digest-matched `contractApproval`.
 *    Only `ApprovedContract` crosses the REST/MCP wire.
 *
 * The contract classifies nothing: there is no `subtype`, `methodProfile`, `rigor`,
 * `kindConfirmation`, or kind registry anywhere in this module. `kind` is a free-form,
 * shape-checked label proposed by the agent and confirmed by the human.
 *
 * `canonicalContractDigest` is the one named, filesystem-free serialisation algorithm
 * every component (this package and Forge) computes identically. Workspace-aware checks
 * that need real filesystem access — realpath containment, disposition/git feasibility —
 * are deliberately NOT part of this module; they live at the server boundary, which has
 * a filesystem to check against.
 */

// ---------------------------------------------------------------------------
// Command execution bounds
// ---------------------------------------------------------------------------

/** Timeout (milliseconds) applied to a `CommandCheck` when it declares none. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/** Highest timeout (milliseconds) a `CommandCheck` may declare. */
export const MAX_COMMAND_TIMEOUT_MS = 1_800_000;

/** Highest combined stdout+stderr byte count captured from one `CommandCheck` run. */
export const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Verification method / disposition
// ---------------------------------------------------------------------------

/**
 * How an acceptance criterion is checked. `agent-review` is the review-by-worker method;
 * this contract API never uses the name `judge` for it.
 */
export const VERIFICATION_METHODS = ['command', 'agent-review', 'human'] as const;
export type VerificationMethod = typeof VERIFICATION_METHODS[number];

/** How the finished solution reaches the caller. Drives `mma-flow` LOCATE, not this module. */
export const DISPOSITIONS = ['pr', 'commit-in-place', 'deliver-file'] as const;
export type Disposition = typeof DISPOSITIONS[number];

// ---------------------------------------------------------------------------
// kind shape (INV-5): non-blank, at most 200 characters, no control character.
// Shape-only — no vocabulary rule, no allow-list.
// ---------------------------------------------------------------------------

const KIND_MAX_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

const kindSchema = z
  .string()
  .min(1, 'kind must not be blank')
  .max(KIND_MAX_LENGTH, `kind must be at most ${KIND_MAX_LENGTH} characters`)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'kind must not contain a control character',
  });

// ---------------------------------------------------------------------------
// Artifact path shape — lexical only, no filesystem access.
// Rejects what is knowable without touching disk: an absolute path or a literal `..`
// segment. Realpath containment (symlink escape, root resolution) is a server-boundary
// concern, not this module's.
// ---------------------------------------------------------------------------

function isLexicallySafeRelativePath(rawPath: string): boolean {
  const unified = rawPath.replace(/\\/g, '/');
  if (unified.startsWith('/')) return false; // POSIX absolute
  if (/^[a-zA-Z]:\//.test(unified)) return false; // Windows drive-letter absolute
  const segments = unified.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  return !segments.includes('..');
}

/** Collapses `.` segments and repeated separators, and unifies separators to `/`.
 *  Lexical only: no filesystem access, no symlink resolution. Used both to detect
 *  duplicate artifacts after normalisation and inside `canonicalContractDigest`. */
export function normalizeArtifactPath(rawPath: string): string {
  const unified = rawPath.normalize('NFC').replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/');
  const segments = unified.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  return (isAbsolute ? '/' : '') + segments.join('/');
}

// ---------------------------------------------------------------------------
// DeclaredArtifact
// ---------------------------------------------------------------------------

export const declaredArtifactSchema = z
  .object({
    path: z.string().min(1, 'artifact path must not be blank'),
    root: z.string().min(1, 'artifact root must not be blank'),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (!isLexicallySafeRelativePath(artifact.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: 'artifact path must be relative and must not contain an absolute prefix or a ".." segment',
      });
    }
  });
export type DeclaredArtifact = z.infer<typeof declaredArtifactSchema>;

// ---------------------------------------------------------------------------
// DeclaredReference / ResolvedReference (INV-6)
// ---------------------------------------------------------------------------

/** What a claim must be checked against, as stated in the approved contract. */
export const declaredReferenceSchema = z
  .object({
    kind: z.string().min(1, 'reference kind must not be blank'),
    locator: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    digest: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((reference, ctx) => {
    if (reference.kind === 'none') {
      if (!reference.reason) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: "a reference of kind 'none' requires a non-empty reason",
        });
      }
      return;
    }
    if (!reference.locator && !reference.digest) {
      ctx.addIssue({
        code: 'custom',
        path: ['locator'],
        message: "a reference must carry a locator or a digest unless its kind is 'none'",
      });
    }
  });
export type DeclaredReference = z.infer<typeof declaredReferenceSchema>;

/** What was actually observed at check time, as recorded in evidence. Never part of the
 *  declared contract — a declared reference must not carry an observation timestamp. */
export const resolvedReferenceSchema = z
  .object({
    locator: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    digest: z.string().min(1).optional(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResolvedReference = z.infer<typeof resolvedReferenceSchema>;

// ---------------------------------------------------------------------------
// CommandCheck — an argument array, never a shell string.
// ---------------------------------------------------------------------------

export const commandCheckSchema = z
  .object({
    program: z.string().min(1, 'command program must not be blank'),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS, `timeoutMs must be at most ${MAX_COMMAND_TIMEOUT_MS}`).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (command.cwd !== undefined && !isLexicallySafeRelativePath(command.cwd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cwd'],
        message: 'command cwd must be relative and must not contain an absolute prefix or a ".." segment',
      });
    }
  });
export type CommandCheck = z.infer<typeof commandCheckSchema>;

// ---------------------------------------------------------------------------
// DeliverableAcceptance (INV-4)
// ---------------------------------------------------------------------------

export const deliverableAcceptanceSchema = z
  .object({
    id: z.string().min(1, 'acceptance id must not be blank'),
    criterion: z.string().min(1, 'acceptance criterion must not be blank'),
    method: z.enum(VERIFICATION_METHODS),
    references: z.array(declaredReferenceSchema).min(1, 'acceptance requires at least one reference'),
    command: commandCheckSchema.optional(),
  })
  .strict()
  .superRefine((acceptance, ctx) => {
    const hasCommand = acceptance.command !== undefined;
    const isCommandMethod = acceptance.method === 'command';
    if (isCommandMethod && !hasCommand) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: "method 'command' requires a command" });
    }
    if (!isCommandMethod && hasCommand) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: "command is present only when method is 'command'" });
    }
  });
export type DeliverableAcceptance = z.infer<typeof deliverableAcceptanceSchema>;

// ---------------------------------------------------------------------------
// ContractApproval — the gate. Bound to the digest of the content it approves.
// ---------------------------------------------------------------------------

export const contractApprovalSchema = z
  .object({
    contractDigest: z.string().min(1, 'contractDigest must not be blank'),
    approvedBy: z.string().min(1, 'approvedBy must not be blank'),
    approvedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ContractApproval = z.infer<typeof contractApprovalSchema>;

// ---------------------------------------------------------------------------
// Shared proposed-state invariants (INV-2 duplicate ids, INV-2 vacuous completion,
// duplicate normalized artifacts). Shared between ProposedContract and ApprovedContract,
// since the approved state carries every proposed-state field.
// ---------------------------------------------------------------------------

function checkProposedInvariants(
  contract: { artifacts: DeclaredArtifact[]; acceptance: DeliverableAcceptance[] },
  ctx: z.RefinementCtx,
): void {
  const seenArtifacts = new Set<string>();
  contract.artifacts.forEach((artifact, index) => {
    const key = `${artifact.root}\u0000${normalizeArtifactPath(artifact.path)}`;
    if (seenArtifacts.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index],
        message: `duplicate artifact after normalisation: root '${artifact.root}' path '${artifact.path}'`,
      });
    }
    seenArtifacts.add(key);
  });

  const seenIds = new Set<string>();
  contract.acceptance.forEach((criterion, index) => {
    if (seenIds.has(criterion.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptance', index, 'id'],
        message: `duplicate acceptance id '${criterion.id}'`,
      });
    }
    seenIds.add(criterion.id);
  });

  // INV-2 — no vacuous completion: an empty artifact set is permitted only when at
  // least one criterion is a terminal command criterion (method 'command' with a
  // non-empty program).
  if (contract.artifacts.length === 0) {
    const hasTerminalCommand = contract.acceptance.some(
      (criterion) => criterion.method === 'command' && (criterion.command?.program.length ?? 0) > 0,
    );
    if (!hasTerminalCommand) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'an empty artifact set requires at least one terminal command criterion',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The three contract states
// ---------------------------------------------------------------------------

export const draftContractSchema = z
  .object({
    state: z.literal('draft'),
    audience: z.string().min(1, 'audience must not be blank'),
    kind: kindSchema.optional(),
  })
  .strict();
export type DraftContract = z.infer<typeof draftContractSchema>;

const proposedContractShape = {
  audience: z.string().min(1, 'audience must not be blank'),
  kind: kindSchema,
  artifacts: z.array(declaredArtifactSchema),
  acceptance: z.array(deliverableAcceptanceSchema).min(1, 'acceptance requires at least one criterion'),
  disposition: z.enum(DISPOSITIONS),
};

export const proposedContractSchema = z
  .object({
    state: z.literal('proposed'),
    ...proposedContractShape,
  })
  .strict()
  .superRefine(checkProposedInvariants);
export type ProposedContract = z.infer<typeof proposedContractSchema>;

export const approvedContractSchema = z
  .object({
    state: z.literal('approved'),
    ...proposedContractShape,
    contractApproval: contractApprovalSchema,
  })
  .strict()
  .superRefine((contract, ctx) => {
    checkProposedInvariants(contract, ctx);
    const expectedDigest = canonicalContractDigest(contract);
    if (contract.contractApproval.contractDigest !== expectedDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['contractApproval', 'contractDigest'],
        message: 'contractApproval.contractDigest does not match the canonical digest of this contract',
      });
    }
  });
export type ApprovedContract = z.infer<typeof approvedContractSchema>;

// ---------------------------------------------------------------------------
// canonicalContractDigest — the one named, filesystem-free serialisation algorithm.
//
//  1. Recursively sort object keys by UTF-8 code point (UTF-8's byte order matches
//     Unicode code point order, so comparing code points is sufficient).
//  2. PRESERVE `acceptance` order (semantic — commands run in declared order).
//     SORT `artifacts` by `root` then normalised `path` (not semantic).
//  3. Normalise strings to NFC. Normalise each artifact's `path` LEXICALLY ONLY — no
//     filesystem access, no symlink resolution. `root` is compared verbatim.
//  4. EXCLUDE `state` and `contractApproval` — lifecycle facts, not deliverable content.
//  5. Encode as UTF-8 JSON with no insignificant whitespace; digest with SHA-256.
// ---------------------------------------------------------------------------

function compareByCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>)
      .map((key) => key.normalize('NFC'))
      .sort(compareByCodePoint);
    const canonical: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      canonical[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return canonical;
  }
  return value;
}

/** The digest content: every field an approval is over, and nothing else. `state` and
 *  `contractApproval` are deliberately excluded from this type — passing a full
 *  `ProposedContract` or `ApprovedContract` is fine, since both are structural
 *  supersets and the extra fields are simply not read. */
type ContractDigestContent = Pick<ProposedContract, 'kind' | 'audience' | 'artifacts' | 'acceptance' | 'disposition'>;

export function canonicalContractDigest(contract: ContractDigestContent): string {
  const normalizedArtifacts = contract.artifacts
    .map((artifact) => ({ root: artifact.root, path: normalizeArtifactPath(artifact.path) }))
    .sort((a, b) => compareByCodePoint(a.root, b.root) || compareByCodePoint(a.path, b.path));

  const digestContent = canonicalizeValue({
    kind: contract.kind,
    audience: contract.audience,
    disposition: contract.disposition,
    artifacts: normalizedArtifacts,
    // Acceptance order is preserved by canonicalizeValue's array handling — it maps
    // each element in place and never sorts the array itself.
    acceptance: contract.acceptance,
  });

  const json = JSON.stringify(digestContent);
  const hex = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hex}`;
}
