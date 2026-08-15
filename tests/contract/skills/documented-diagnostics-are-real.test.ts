/**
 * The router's "diagnosing slow tasks" procedure was wrong in four independent ways at once.
 *
 * It read: "`mma serve --verbose` (or `diagnostics.verbose: true` in config) records `tool_call`,
 * `turn_complete`, and `heartbeat` events. Tail with `mma logs --follow --task=$TASK_ID`."
 *
 *   - there is no `--verbose` flag; stderr streaming has been unconditional since 4.7.3, and the
 *     CLI source says so in a comment
 *   - `diagnostics` accepts `log` and `logDir` only, and the object is non-strict, so
 *     `diagnostics.verbose: true` is SILENTLY dropped — the user edits their config, gets no error
 *     and no logs
 *   - the emitted kinds are `batch_*` and `provider_event`; `tool_call`, `turn_complete` and
 *     `heartbeat` are not kinds (`heartbeat` appears nowhere in the engine at all)
 *   - `runLogs` reads `--follow` and `--batch`; `--task` is ignored, so the caller gets the entire
 *     unfiltered log instead of one execution's trace
 *
 * Every step of a documented diagnosis procedure was a no-op or a silent wrong-flag fallback — and
 * this is the procedure someone follows when something is already going wrong.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlainLogKindEnum, PROVIDER_EVENT_NAMES } from '../../../packages/core/src/events/plain-log-entry.js';
import { TYPE_REGISTRY } from '../../../packages/core/src/unified/type-registry.js';

const SKILLS_DIR = 'packages/server/src/skills';

const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== '_shared')
  .map((e) => join(SKILLS_DIR, e.name, 'SKILL.md'));

/** Names a doc might present as loggable events that the engine never emits. */
const PHANTOM_EVENTS = ['heartbeat', 'turn_complete', 'tool_call'];

/** Flags a doc might present that the CLI does not parse. */
const PHANTOM_FLAGS = ['--verbose', '--task='];

describe('skills name only diagnostics the engine provides', () => {
  it('finds skills to scan', () => {
    expect(skillFiles.length).toBeGreaterThan(15);
  });

  it.each(skillFiles)('%s names no phantom event kind', (file) => {
    const text = readFileSync(file, 'utf8');
    // Backticked, i.e. presented as an identifier rather than used as prose.
    const named = PHANTOM_EVENTS.filter((name) => text.includes(`\`${name}\``));
    expect(named, `${file} presents non-existent event kinds: ${named.join(', ')}`).toEqual([]);
  });

  it.each(skillFiles)('%s puts no phantom flag in a command line', (file) => {
    const text = readFileSync(file, 'utf8');
    // Only backticked COMMANDS count. Saying "there is no `--verbose` flag" is useful prose — the
    // old doc taught that flag, so denying it explicitly is worth keeping — and a test that
    // forbade the word would forbid correcting the record.
    const commands = [...text.matchAll(/`([^`]*\bmma\b[^`]*)`/g)].map((m) => m[1]!);
    const offenders = commands.filter((cmd) => PHANTOM_FLAGS.some((flag) => cmd.includes(flag)));
    expect(offenders, `${file} shows commands using flags the CLI ignores: ${offenders.join(' | ')}`)
      .toEqual([]);
  });

  it('the real vocabularies are what this test assumes', () => {
    // Premise. If `heartbeat` ever becomes a kind, this list is what is wrong.
    for (const phantom of PHANTOM_EVENTS) {
      expect(PlainLogKindEnum.options as readonly string[]).not.toContain(phantom);
      expect(PROVIDER_EVENT_NAMES as readonly string[]).not.toContain(phantom);
    }
    expect(PlainLogKindEnum.options).toContain('provider_event');
  });
});

/**
 * Escalation advice must key on fields the caller receives.
 *
 * The router's only concrete standard→complex rule read: "A prior standard run came back with
 * `filesWritten: 0` or `incompleteReason: 'turn_cap'` / `'timeout'`." `incompleteReason` exists
 * NOWHERE in the engine, and `filesWritten` is an internal field — the terminal envelope carries
 * `output.filesChanged`. So a caller inspecting both keys finds them undefined every time and
 * concludes escalation is never warranted, which is the opposite of the advice's intent.
 */
describe('escalation advice names fields the envelope carries', () => {
  const router = readFileSync(join(SKILLS_DIR, 'multi-model-agent', 'SKILL.md'), 'utf8');
  const resultShape = readFileSync('packages/server/src/application/result-shape.ts', 'utf8');

  it('names filesChanged, the field that exists', () => {
    expect(router).toContain('output.filesChanged');
    expect(resultShape, 'the envelope field was renamed — update the router').toContain('filesChanged');
  });

  it('does not key on fields the envelope lacks', () => {
    expect(router).not.toMatch(/`filesWritten: 0`/);
    expect(router).not.toMatch(/`incompleteReason`?:/);
  });

  it('the error codes it names are real', () => {
    const codes = readFileSync('packages/core/src/error-codes.ts', 'utf8');
    for (const code of ['sdk_max_turns', 'wall_clock_exceeded']) {
      expect(router, `router names ${code}`).toContain(code);
      expect(codes, `${code} is not a real error code`).toContain(`'${code}'`);
    }
  });
});

/**
 * The terminal-context-block rule, stated by SANDBOX rather than by read/write.
 *
 * Three docs said "every completed read-route task (audit / review / debug / investigate /
 * research) auto-registers … write routes return null". Wrong in both directions.
 * `execution-runtime` gates on `run.sandbox === 'read-only'`, which is SIX types — the list omitted
 * `journal_recall`, whose own skill doc gets it right, so two docs described one mechanism
 * differently. And `spec`/`plan` are read routes (`writeRoute: false`) that are `cwd-only` because
 * they write their document, so they return null: the router's own recommended snippet
 * (`priorResults.map(r => r.contextBlockId).filter(id => id !== null)`) silently drops every spec
 * and plan result, and a caller chaining plan → execute-plan by block id gets nothing, with no
 * error.
 */
describe('the context-block rule matches the sandbox gate', () => {
  const registering = Object.entries(TYPE_REGISTRY)
    .filter(([, cfg]) => (cfg as { sandbox: string }).sandbox === 'read-only')
    .map(([type]) => type);

  const DOCS = [
    join(SKILLS_DIR, 'multi-model-agent', 'SKILL.md'),
    join(SKILLS_DIR, 'mma-research', 'SKILL.md'),
    join(SKILLS_DIR, '_shared', 'response-shape.md'),
  ];

  it('six types register, and journal_recall is one of them', () => {
    expect(registering).toContain('journal_recall');
    expect(registering).toHaveLength(6);
  });

  it.each(DOCS)('%s names every registering type', (file) => {
    const text = readFileSync(file, 'utf8');
    for (const type of registering) {
      expect(text, `${file} omits ${type}, which does register a block`).toContain(type);
    }
  });

  it.each(DOCS)('%s warns that spec and plan return null', (file) => {
    const text = readFileSync(file, 'utf8');
    expect(text, `${file} must say spec/plan are null despite reading`).toMatch(/spec[^.\n]*plan|plan[^.\n]*spec/i);
  });
});

/**
 * A dispatch example must name tools that exist and describe what they return.
 *
 * `mma-explore`'s only concrete example showed six calls to `mma-investigate` / `mma-research` /
 * `mma-journal-recall`. None is an MCP tool: the surface is `mma_run` plus `mma_execution_*`, and
 * `mma_run` requires `cwd` and `request` with `additionalProperties: false`. A caller copying the
 * example calls nothing, or gets a schema rejection — and the same file says correctly, sixty lines
 * earlier, that it dispatches "via `mma_run`".
 *
 * It also told the caller to read `output.summary.findings` off every leg. Only `journal_recall` is
 * returned inline (`INLINE_AUTO_TYPES`); `investigate` and `research` — the bulk of the fan-out —
 * return a handle with no `output` key, so `output.summary` is `undefined` and the skill's own
 * sentinel rule then stamps "(no internal anchor — fully greenfield)" over investigations that
 * succeeded.
 */
describe('the explore skill dispatches through tools that exist', () => {
  const explore = readFileSync(join(SKILLS_DIR, 'mma-explore', 'SKILL.md'), 'utf8');

  it('its example calls mma_run, not a per-route tool', async () => {
    const { MCP_TOOLS } = await import('../../../packages/server/src/mcp/tool-surface.js');
    const toolNames = new Set(MCP_TOOLS.map((t) => t.name));

    // Any `mma-<something>` used as a CALL in the example block is not a tool name.
    const fenced = [...explore.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!).join('\n');
    const called = [...fenced.matchAll(/^\s*(mma[-_][a-z_-]+)\s*\{/gm)].map((m) => m[1]!);
    expect(called.length, 'no dispatch example found to check').toBeGreaterThan(0);
    for (const name of new Set(called)) {
      expect(toolNames.has(name), `the example calls '${name}', which is not an MCP tool`).toBe(true);
    }
  });

  it('tells the caller to poll the legs that return handles', async () => {
    const { INLINE_AUTO_TYPES } = await import('../../../packages/server/src/mcp/tool-surface.js');
    // Premise: investigate/research are NOT inline, so they must be polled.
    expect(INLINE_AUTO_TYPES.has('investigate')).toBe(false);
    expect(INLINE_AUTO_TYPES.has('research')).toBe(false);

    expect(explore, 'must name the polling tool').toMatch(/mma_execution_wait|mma_execution_get/);
    expect(explore, 'must say a handle carries no output').toMatch(/no `output` key|returns? a HANDLE/i);
  });
});
