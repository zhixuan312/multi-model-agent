/**
 * Which props each task type gets on the execution monitor's stage.
 *
 * The VERB is not a taste decision: it is the type's capability, taken from `TYPE_REGISTRY`.
 * A hammer on screen means the route writes your files and commits; a lens means it is
 * sandboxed read-only and cannot alter what it examines; a quill means it authors a document.
 * That makes the animation carry information a user actually needs in peripheral vision.
 *
 * The table is duplicated here rather than imported from core ON PURPOSE: this module is
 * bundled into a single-file HTML App served to the host, and pulling the core package in
 * to read three booleans would drag the engine's dependency graph into a 350 KB UI bundle.
 * `tests/contract/mcp/execution-app-scene.test.ts` cross-checks every entry against the real
 * `TYPE_REGISTRY` — coverage of every member, and the verb against `writeRoute`/`sandbox` — so
 * the copy cannot drift silently. (This named `type-art-registry.test.ts`, a file that has never
 * existed: the pointer to the thing that makes a deliberate duplicate safe was itself wrong.)
 */

export type Verb = 'strike' | 'draft' | 'probe';
export type ToolId = 'hammer' | 'quill' | 'compass' | 'lens' | 'rod' | 'sheaf' | 'lever';

export interface TypeArt {
  /** Key into the subject table in `scene.ts`. */
  subject: string;
  tool: ToolId;
  verb: Verb;
}

/**
 * One entry per member of core's `TASK_TYPES`. Kept in that order for review against the
 * registry.
 */
export const TYPE_ART: Record<string, TypeArt> = {
  audit: { subject: 'audit', tool: 'lens', verb: 'probe' },
  investigate: { subject: 'investigate', tool: 'lens', verb: 'probe' },
  delegate: { subject: 'delegate', tool: 'hammer', verb: 'strike' },
  execute_plan: { subject: 'execute_plan', tool: 'hammer', verb: 'strike' },
  review: { subject: 'review', tool: 'lens', verb: 'probe' },
  debug: { subject: 'debug', tool: 'rod', verb: 'probe' },
  research: { subject: 'research', tool: 'sheaf', verb: 'probe' },
  journal_recall: { subject: 'journal_recall', tool: 'lens', verb: 'probe' },
  journal_record: { subject: 'journal_record', tool: 'quill', verb: 'draft' },
  orchestrate: { subject: 'orchestrate', tool: 'lever', verb: 'draft' },
  spec: { subject: 'spec', tool: 'quill', verb: 'draft' },
  plan: { subject: 'plan', tool: 'compass', verb: 'draft' },
};

/**
 * Art for an unknown type.
 *
 * A task type added to `TYPE_REGISTRY` without art here must still render a working panel —
 * a monitor that breaks because someone extended an enum is worse than a generic bench. The
 * default is deliberately the read-only prop set: understating what a route may do to your
 * files is the safe direction to be wrong in.
 */
export const DEFAULT_ART: TypeArt = { subject: 'default', tool: 'lens', verb: 'probe' };

export function artFor(type: string | undefined): TypeArt {
  if (!type) return DEFAULT_ART;
  return TYPE_ART[type] ?? DEFAULT_ART;
}
