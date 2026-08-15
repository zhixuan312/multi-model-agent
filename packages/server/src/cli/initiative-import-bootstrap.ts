/**
 * initiative-import-bootstrap.ts — `mma initiatives import-bootstrap --stem <stem>`.
 *
 * Assisted, idempotent import of one `.mma/` flow stem into the Initiative Record
 * (FR-14, FR-15, FR-16 — see `.mma/specs/2026-08-12-mma-next-initiative-engine.md`,
 * "Implementation details" and the bootstrap-value table). TRANSCRIPTION, not
 * design: every pinned stderr line, exit code, and bootstrap value below is
 * frozen by that specification — do not invent alternates.
 *
 * Resolution order (each gate short-circuits before any database write):
 *   1. Nearest ancestor `.mma/` directory from `cwd` (no ancestor -> pinned
 *      no-workspace error).
 *   2. Required `.mma/specs/<stem>.md` with non-empty `title`/`goal`
 *      frontmatter (missing or invalid -> pinned metadata error).
 *   3. Load config, open the Initiative runtime.
 *   4. Human-key precondition: the Initiative table must be empty (first run)
 *      or already contain `MMA-INIT-001` (rerun) (violated -> pinned
 *      precondition error, zero writes).
 *   5. Find-or-create Product/Workspace/Resource, find-or-create
 *      `MMA-INIT-001`, register found artifacts (composite-key
 *      create-or-update, idempotent by content hash), and optionally create
 *      open Tasks from top-level plan task headings.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  InitiativeNotFoundError,
  type ArtifactRef,
  type Initiative,
  type InitiativeProvenance,
  type MultiModelConfig,
  type Product,
  type Resource,
  type Task,
  type Workspace,
} from '@zhixuan92/multi-model-agent-core';
import { InitiativeRecordRuntime } from '../application/initiative-record-runtime.js';

export interface ImportBootstrapDeps {
  /** Starting point for nearest-`.mma/` ancestor resolution (usually the process cwd). */
  cwd: string;
  /** `--stem` value. */
  stem: string;
  /** Loads the resolved server config — same discovery order as every other subcommand. */
  loadConfig: () => Promise<MultiModelConfig>;
  /** Opens the Initiative runtime. Defaults to `InitiativeRecordRuntime.open`; injectable for unit tests. */
  openRuntime?: (opts: { stateDir: string }) => InitiativeRecordRuntime;
  /** Overrides the provenance timestamp. Defaults to the real clock. */
  now?: () => string;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

const PRODUCT_SLUG = 'mma';
const WORKSPACE_SLUG = 'mma-engine';
const BOOTSTRAP_HUMAN_KEY = 'MMA-INIT-001';
/**
 * "Top-level plan task heading" (FR-16) — this project's own plans (the real
 * bootstrap input) mark each task with a heading starting "Task " at heading
 * level 1-4 (e.g. `### Task I-8: ...`). Lower-level items (bullets, nested
 * checklists) never match a heading pattern at all, satisfying "the
 * implementation must not inspect lower-level plan lists".
 */
const TASK_HEADING_RE = /^#{1,4}\s+(Task\s+.+?)\s*$/i;

/** Walks up from `startDir` (inclusive) to the nearest ancestor containing a `.mma/` directory. */
function findWorkspaceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.mma');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Extracts `title`/`goal` from a leading `---`-delimited YAML-ish frontmatter block. Returns null if absent, unparsable, or either field is empty. */
function parseFrontmatter(content: string): { title: string; goal: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!fieldMatch) continue;
    let value = fieldMatch[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[fieldMatch[1]] = value;
  }
  const title = fields.title ?? '';
  const goal = fields.goal ?? '';
  if (!title || !goal) return null;
  return { title, goal };
}

/** Reads and parses the required spec artifact's frontmatter. Returns null for a missing file, an unreadable file, or invalid/empty title-or-goal. */
function readSpecFrontmatter(specPath: string): { title: string; goal: string } | null {
  if (!existsSync(specPath)) return null;
  let content: string;
  try {
    content = readFileSync(specPath, 'utf-8');
  } catch {
    return null;
  }
  return parseFrontmatter(content);
}

/** Converts a single-`*`-wildcard glob pattern (e.g. `flow--*.md`) into an exact-match RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Lists absolute paths of files in `dir` matching `pattern`, sorted for determinism. Returns `[]` for a missing directory. */
function listGlobMatches(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return [];
  const regex = globToRegex(pattern);
  return readdirSync(dir)
    .filter((name) => regex.test(name))
    .sort()
    .map((name) => join(dir, name));
}

/** Best-effort `git remote get-url origin` for the resolved engine repo path. Returns null when unresolvable (no repo, no origin, `git` unavailable). */
function resolveGitOriginUrl(repoPath: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, // not platform-gated: this runs on Windows and flashes a console without it
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function mediaTypeFor(path: string): string | undefined {
  const ext = extname(path);
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  return undefined;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function bootstrapProvenance(now: string): InitiativeProvenance {
  return {
    actor_type: 'system',
    actor_id: 'cli:import-bootstrap',
    interface: 'cli',
    initiated_by: 'cli:import-bootstrap',
    authorized_by: 'human:maintainer',
    timestamp: now,
    source: 'imported',
  };
}

function findOrCreateProduct(runtime: InitiativeRecordRuntime, provenance: InitiativeProvenance): Product {
  try {
    return runtime.execute({ operation: 'product_get', input: { slug: PRODUCT_SLUG } }) as Product;
  } catch (err) {
    if (!(err instanceof InitiativeNotFoundError)) throw err;
    return runtime.execute({
      operation: 'product_create',
      input: { name: 'MMA', slug: PRODUCT_SLUG },
      expected_revision: 0,
      provenance,
    }) as Product;
  }
}

function findOrCreateWorkspace(
  runtime: InitiativeRecordRuntime,
  productId: string,
  provenance: InitiativeProvenance,
): Workspace {
  const list = runtime.execute({ operation: 'workspace_list', input: { product_id: productId } }) as Workspace[];
  const existing = list.find((w) => w.slug === WORKSPACE_SLUG);
  if (existing) return existing;
  return runtime.execute({
    operation: 'workspace_create',
    input: {
      product_id: productId,
      name: 'MMA Engine',
      slug: WORKSPACE_SLUG,
      description: 'The multi-model-agent engine repository workspace.',
    },
    expected_revision: 0,
    provenance,
  }) as Workspace;
}

function findOrCreateResource(
  runtime: InitiativeRecordRuntime,
  workspaceId: string,
  workspaceRoot: string,
  provenance: InitiativeProvenance,
): Resource {
  const enginePath = join(workspaceRoot, 'multi-model-agent');
  const canonicalLocator = resolveGitOriginUrl(enginePath) ?? 'multi-model-agent';
  const list = runtime.execute({ operation: 'resource_list', input: { workspace_id: workspaceId } }) as Resource[];
  const existing = list.find((r) => r.canonical_locator === canonicalLocator);
  if (existing) return existing;
  return runtime.execute({
    operation: 'resource_register',
    input: {
      workspace_id: workspaceId,
      type: 'git_repository',
      canonical_locator: canonicalLocator,
      local_path: enginePath,
      description: 'The multi-model-agent engine git repository.',
    },
    expected_revision: 0,
    provenance,
  }) as Resource;
}

interface Candidate {
  store: 'explorations' | 'specs' | 'plans' | 'backlogs';
  path: string;
}

export async function runInitiativesImportBootstrap(deps: ImportBootstrapDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const now = deps.now ? deps.now() : new Date().toISOString();
  const provenance = bootstrapProvenance(now);

  // 1. Workspace resolution.
  // 0. Stem must be a plain file stem — never a path. Separators (or a bare
  // dot segment) would let the joins below escape the workspace's `.mma/`
  // stores; an inner '..' in an otherwise plain filename cannot traverse and
  // stays allowed.
  if (/[/\\]/.test(deps.stem) || deps.stem === '.' || deps.stem === '..') {
    stderr(`invalid stem: ${deps.stem}\n`);
    return 1;
  }

  const workspaceRoot = findWorkspaceRoot(deps.cwd);
  if (!workspaceRoot) {
    stderr(`no .mma workspace found from: ${deps.cwd}\n`);
    return 1;
  }

  // 2. Required specification metadata.
  const specPath = join(workspaceRoot, '.mma', 'specs', `${deps.stem}.md`);
  const frontmatter = readSpecFrontmatter(specPath);
  if (!frontmatter) {
    stderr(`bootstrap metadata error: ${specPath} missing title or goal frontmatter\n`);
    return 1;
  }

  // 3. Config + runtime.
  let config: MultiModelConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    stderr(`bootstrap import error: cannot load config: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const openRuntime = deps.openRuntime ?? ((opts: { stateDir: string }) => InitiativeRecordRuntime.open(opts));
  const runtime = openRuntime({ stateDir: config.server.stateDir });

  try {
    return importBootstrap(runtime, { workspaceRoot, stem: deps.stem, specPath, frontmatter, provenance, stdout, stderr });
  } catch (err) {
    stderr(`bootstrap import error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    runtime.close();
  }
}

function importBootstrap(
  runtime: InitiativeRecordRuntime,
  params: {
    workspaceRoot: string;
    stem: string;
    specPath: string;
    frontmatter: { title: string; goal: string };
    provenance: InitiativeProvenance;
    stdout: (s: string) => boolean;
    stderr: (s: string) => boolean;
  },
): number {
  const { workspaceRoot, stem, specPath, frontmatter, provenance, stdout, stderr } = params;

  // 4. Human-key precondition — read-only, so a violation writes nothing.
  let initiative: Initiative | undefined;
  let isFreshBootstrap = false;
  try {
    initiative = runtime.execute({ operation: 'initiative_get', input: { human_key: BOOTSTRAP_HUMAN_KEY } }) as Initiative;
  } catch (err) {
    if (!(err instanceof InitiativeNotFoundError)) throw err;
    const allInitiatives = runtime.execute({ operation: 'initiative_list', input: {} }) as Initiative[];
    if (allInitiatives.length > 0) {
      stderr(`bootstrap precondition failed: initiative table is not empty and ${BOOTSTRAP_HUMAN_KEY} does not exist\n`);
      return 1;
    }
    isFreshBootstrap = true;
  }

  // 5a. Find-or-create Product / Workspace / Resource (safe on rerun — find first, create only if absent).
  const product = findOrCreateProduct(runtime, provenance);
  const workspace = findOrCreateWorkspace(runtime, product.uuid, provenance);
  findOrCreateResource(runtime, workspace.uuid, workspaceRoot, provenance);

  // 5b. Find-or-create the bootstrap Initiative. A rerun leaves title/goal unchanged.
  if (isFreshBootstrap) {
    initiative = runtime.execute({
      operation: 'initiative_create',
      input: { product_id: product.uuid, title: frontmatter.title, goal: frontmatter.goal, status: 'open', outcome: null },
      expected_revision: 0,
      provenance,
    }) as Initiative;
  }
  const resolvedInitiative = initiative!;

  // Snapshot current artifacts/tasks once, so reruns find existing revisions/titles rather than duplicating.
  const resume = runtime.initiativeResume({ initiative: { human_key: BOOTSTRAP_HUMAN_KEY } });
  const existingArtifactsByPath = new Map<string, ArtifactRef>(resume.artifacts.map((a) => [a.path_or_uri, a]));
  const existingTaskTitles = new Set<string>(resume.tasks.map((t) => t.title));

  // Candidate resolution: required spec (already validated) + optional exploration/plan/backlog artifacts.
  const found: Candidate[] = [{ store: 'specs', path: specPath }];

  const explorationPath = join(workspaceRoot, '.mma', 'explorations', `${stem}.md`);
  if (existsSync(explorationPath)) {
    found.push({ store: 'explorations', path: explorationPath });
  } else {
    stderr(`missing artifact: ${explorationPath}\n`);
  }

  const planPath = join(workspaceRoot, '.mma', 'plans', `${stem}.md`);
  if (existsSync(planPath)) {
    found.push({ store: 'plans', path: planPath });
  } else {
    stderr(`missing artifact: ${planPath}\n`);
  }

  const plansDir = join(workspaceRoot, '.mma', 'plans');
  const planFanoutMatches = listGlobMatches(plansDir, `${stem}--*.md`);
  if (planFanoutMatches.length > 0) {
    for (const p of planFanoutMatches) found.push({ store: 'plans', path: p });
  } else {
    stderr(`missing artifact: ${join(plansDir, `${stem}--*.md`)}\n`);
  }

  const backlogsDir = join(workspaceRoot, '.mma', 'backlogs');
  const backlogMatches = listGlobMatches(backlogsDir, `${stem}.*`);
  if (backlogMatches.length > 0) {
    for (const p of backlogMatches) found.push({ store: 'backlogs', path: p });
  } else {
    stderr(`missing artifact: ${join(backlogsDir, `${stem}.*`)}\n`);
  }

  // 5c. Register every found artifact (composite-key create-or-update, idempotent replay on unchanged content).
  for (const candidate of found) {
    const content = readFileSync(candidate.path);
    const hash = sha256Hex(content);
    const mediaType = mediaTypeFor(candidate.path);
    const existing = existingArtifactsByPath.get(candidate.path);
    const expectedRevision = existing ? existing.revision : 0;
    runtime.execute({
      operation: 'artifact_register',
      input: {
        initiative_id: resolvedInitiative.uuid,
        storage_mode: 'external',
        path_or_uri: candidate.path,
        content_hash: hash,
        ...(mediaType !== undefined && { media_type: mediaType }),
        description: `Imported ${candidate.store} artifact for stem ${stem}.`,
      },
      expected_revision: expectedRevision,
      idempotency_key: `import-bootstrap:artifact:${candidate.path}:${hash}`,
      provenance,
    });
  }

  // 5d. Open Tasks from top-level plan task headings (idempotent by title; never re-creates one already present).
  for (const candidate of found.filter((c) => c.store === 'plans')) {
    const content = readFileSync(candidate.path, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const headingMatch = line.match(TASK_HEADING_RE);
      if (!headingMatch) continue;
      const title = headingMatch[1];
      if (existingTaskTitles.has(title)) continue;
      existingTaskTitles.add(title);
      runtime.execute({
        operation: 'initiative_task_create',
        input: {
          initiative_id: resolvedInitiative.uuid,
          title,
          goal: title,
          status: 'open',
          outcome: null,
          workspace_ids: [workspace.uuid],
          resource_ids: [],
        },
        expected_revision: 0,
        provenance,
      }) as Task;
    }
  }

  stdout(`initiatives import-bootstrap: ${resolvedInitiative.human_key} ready (${found.length} artifact(s) checked)\n`);
  return 0;
}
