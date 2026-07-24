import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  allocateNextNodeId,
  parseJournalNodeDocument,
  renderNodeFilename,
  renderNodeMarkdown,
  validateJournalLinkSet,
  type JournalLink,
  type JournalNodeDocument,
  type JournalNodeStatus,
  type JournalNodeType,
} from './node-codec.js';

export interface CreateDecision {
  kind: 'create' | 'refine' | 'supersede';
  targetNodeId?: string;
  title: string;
  type: JournalNodeType;
  topic: string;
  tags: string[];
  links: JournalLink[];
  status: JournalNodeStatus;
  description: string;
  context: string;
  consequences: string;
}

export interface MergeDecision {
  kind: 'merge';
  targetNodeId: string;
  reason: string;
}

export type JournalRecordDecision = CreateDecision | MergeDecision;

export interface ApplyRecordInput {
  learning: string;
  decision: JournalRecordDecision;
}

export interface ApplyRecordResult {
  recorded: Array<{ learning: string; type: string; topic: string; nodeId: string; nodePath: string }>;
  failed: Array<{ learning: string; reason: string }>;
  invariantsPassed: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${createHash('sha1').update(content).digest('hex')}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

/**
 * In-process, per-journalRoot serialization lock. Two concurrent `journal_record`
 * requests against the same `.mma/journal` must not interleave: each batch allocates
 * fresh node ids from the CURRENT on-disk node set, so overlapping reads would let both
 * pick the same id and corrupt the graph. Keyed by the resolved absolute journalRoot, a
 * chained promise guarantees each batch loads node state and commits fully before the next
 * begins. Single-process scope only (one server); cross-process coordination is out of scope.
 */
const journalLocks = new Map<string, Promise<unknown>>();

function withJournalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = journalLocks.get(key) ?? Promise.resolve();
  // Run fn after the previous holder settles (success OR failure), so one batch's error
  // never wedges the journal.
  const run = prev.then(() => fn(), () => fn());
  // The gate that the NEXT caller chains on must never reject, or its `.then(onReject)`
  // would swallow into fn early. Swallow both outcomes here; the caller still gets `run`.
  const gate = run.then(() => undefined, () => undefined);
  journalLocks.set(key, gate);
  // Best-effort cleanup: drop the map entry once this is the last settled holder.
  void gate.then(() => {
    if (journalLocks.get(key) === gate) journalLocks.delete(key);
  });
  return run;
}

export class JournalStore {
  static async open(opts: { journalRoot: string }): Promise<JournalStore> {
    const store = new JournalStore(opts.journalRoot);
    await mkdir(join(opts.journalRoot, 'nodes'), { recursive: true });
    return store;
  }

  private constructor(private readonly journalRoot: string) {}

  private get nodesDir(): string {
    return join(this.journalRoot, 'nodes');
  }

  private async loadNodes(): Promise<JournalNodeDocument[]> {
    const files = (await readdir(this.nodesDir)).filter((entry) => entry.endsWith('.md')).sort();
    const docs: JournalNodeDocument[] = [];
    for (const file of files) {
      const raw = await readFile(join(this.nodesDir, file), 'utf8');
      docs.push(parseJournalNodeDocument(raw, join('nodes', file)));
    }
    return docs.sort((a, b) => a.id.localeCompare(b.id));
  }

  private regenerateCatalog(nodes: JournalNodeDocument[]): string {
    const lines = [
      '| id | timestamp | type | status | title | topic | tags |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...nodes.map((node) => `| ${node.id} | ${node.timestamp.slice(0, 10)} | ${node.type} | ${node.status} | ${node.title} | ${node.topic || 'unscoped'} | ${node.tags.join(', ')} |`),
    ];
    return `${lines.join('\n')}\n`;
  }

  /**
   * Re-derive the committed `index.md` catalog from the authoritative node
   * files and atomically overwrite it. Node content is never mutated. This is
   * the opt-in `--regenerate-catalog` entry point for `mma journal reindex`;
   * building/refreshing the derived `index.db` is always safe, but touching the
   * committed `index.md` requires the explicit flag.
   */
  async rebuildCatalog(): Promise<number> {
    const nodes = await this.loadNodes();
    await atomicWrite(join(this.journalRoot, 'index.md'), this.regenerateCatalog(nodes));
    return nodes.length;
  }

  private appendLogLines(entries: Array<{ op: string; id: string; title: string }>): string {
    return `${entries.map((entry) => `${nowIso()}  ${entry.op}  ${entry.id}  ${entry.title}`).join('\n')}\n`;
  }

  /**
   * Remove any leftover staging files (`*.tmp`) from an aborted batch. Temp node
   * files live in `nodes/`; the temp `index.md` / `log.md` live in the journal
   * root — sweep both. Best-effort: a stray obstacle (e.g. a directory) never
   * masks the original error.
   */
  private async cleanupTempFiles(): Promise<void> {
    for (const dir of [this.journalRoot, this.nodesDir]) {
      const entries = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith('.tmp'))
          .map((entry) => rm(join(dir, entry), { force: true }).catch(() => undefined)),
      );
    }
  }

  async applyRecordBatch(records: ApplyRecordInput[]): Promise<ApplyRecordResult> {
    // Serialize per journalRoot and (re)load node state INSIDE the lock, so id allocation
    // reflects any batch that committed while we waited — no stale pre-lock snapshot.
    return withJournalLock(resolve(this.journalRoot), () => this.runRecordBatch(records));
  }

  private async runRecordBatch(records: ApplyRecordInput[]): Promise<ApplyRecordResult> {
    const existingNodes = await this.loadNodes();
    const stagedNodes = existingNodes.map((node) => ({ ...node, tags: [...node.tags], links: [...node.links] }));
    const knownIds = new Set(stagedNodes.map((node) => node.id));
    const recorded: ApplyRecordResult['recorded'] = [];
    const failed: ApplyRecordResult['failed'] = [];
    const logEntries: Array<{ op: string; id: string; title: string }> = [];

    try {
      for (const record of records) {
        const decision = record.decision;
        if (decision.kind === 'merge') {
          const target = stagedNodes.find((node) => node.id === decision.targetNodeId);
          if (!target) throw new Error(`Missing merge target ${decision.targetNodeId}`);
          recorded.push({
            learning: record.learning,
            type: target.type,
            topic: target.topic,
            nodeId: target.id,
            nodePath: target.sourcePath,
          });
          logEntries.push({ op: 'merge', id: target.id, title: target.title });
          continue;
        }

        const id = allocateNextNodeId([...knownIds]);
        knownIds.add(id);

        // refine/supersede carry a relationship to an existing node. Guarantee the
        // edge is emitted (inject it if the decision omitted it) and, for supersede,
        // flip the target's lifecycle status. A refine/supersede with no / a missing
        // target fails the whole batch (all-or-nothing).
        const links: JournalLink[] = [...decision.links];
        if (decision.kind === 'refine' || decision.kind === 'supersede') {
          if (!decision.targetNodeId) throw new Error(`${decision.kind} requires targetNodeId`);
          const target = stagedNodes.find((entry) => entry.id === decision.targetNodeId);
          if (!target) throw new Error(`Missing ${decision.kind} target ${decision.targetNodeId}`);
          const linkType = decision.kind === 'refine' ? 'refines' : 'supersedes';
          if (!links.some((link) => link.type === linkType && link.target === decision.targetNodeId)) {
            links.push({ type: linkType, target: decision.targetNodeId });
          }
          if (decision.kind === 'supersede') {
            target.status = 'superseded';
            target.supersededBy = id;
          }
        }

        const node: JournalNodeDocument = {
          id,
          title: decision.title,
          type: decision.type,
          topic: decision.topic,
          status: decision.status,
          description: decision.description,
          timestamp: nowIso(),
          tags: decision.tags,
          links,
          supersededBy: null,
          context: decision.context,
          consequences: decision.consequences,
          sourcePath: join('nodes', renderNodeFilename({ id, title: decision.title })),
        };

        validateJournalLinkSet(id, node.links, new Set([...knownIds, ...stagedNodes.map((entry) => entry.id)]));
        stagedNodes.push(node);
        recorded.push({ learning: record.learning, type: node.type, topic: node.topic, nodeId: node.id, nodePath: node.sourcePath });
        logEntries.push({ op: decision.kind, id: node.id, title: node.title });
      }

      if (recorded.length + failed.length !== records.length) throw new Error('Submitted record completeness mismatch');

      // Truly all-or-nothing commit. Stage EVERY artifact (node files + index.md + log.md)
      // to a `.tmp` path first; then, before the rename phase, snapshot the exact pre-batch
      // bytes of every target that already exists. Multiple rename()s are not one atomic op,
      // so if rename K fails after 1..K-1 succeeded we must undo them: restore each
      // pre-existing target from its snapshot and delete each newly-created one, so the
      // on-disk journal equals the exact pre-batch state before we re-throw.
      const existingLog = await readFile(join(this.journalRoot, 'log.md'), 'utf8').catch(() => '');
      const artifacts = [
        ...stagedNodes.map((node) => ({ finalPath: join(this.journalRoot, node.sourcePath), content: renderNodeMarkdown(node) })),
        { finalPath: join(this.journalRoot, 'index.md'), content: this.regenerateCatalog(stagedNodes) },
        { finalPath: join(this.journalRoot, 'log.md'), content: `${existingLog}${this.appendLogLines(logEntries)}` },
      ].map((artifact) => ({ ...artifact, tempPath: `${artifact.finalPath}.tmp` }));

      // Temp-write phase: if any temp write fails, nothing has been renamed, so the
      // pre-batch state is untouched — delete the temps and re-throw.
      const writtenTemps: string[] = [];
      try {
        for (const artifact of artifacts) {
          await writeFile(artifact.tempPath, artifact.content, 'utf8');
          writtenTemps.push(artifact.tempPath);
        }
      } catch (writeError) {
        await Promise.all(writtenTemps.map((temp) => rm(temp, { force: true }).catch(() => undefined)));
        throw writeError;
      }

      // Backup phase: capture prior content (or null when the target is new) for every
      // artifact, so the rename phase can be rolled back byte-for-byte.
      const backups = new Map<string, string | null>();
      for (const artifact of artifacts) {
        backups.set(artifact.finalPath, await readFile(artifact.finalPath, 'utf8').catch(() => null));
      }

      // Rename phase: on any failure, roll back every already-renamed target to its
      // pre-batch state, delete leftover temps, and re-throw.
      const renamed: string[] = [];
      try {
        for (const artifact of artifacts) {
          await rename(artifact.tempPath, artifact.finalPath);
          renamed.push(artifact.finalPath);
        }
      } catch (renameError) {
        for (const finalPath of renamed) {
          const prior = backups.get(finalPath) ?? null;
          if (prior === null) {
            await rm(finalPath, { force: true }).catch(() => undefined);
          } else {
            await writeFile(finalPath, prior, 'utf8').catch(() => undefined);
          }
        }
        await Promise.all(writtenTemps.map((temp) => rm(temp, { force: true }).catch(() => undefined)));
        throw renameError;
      }

      return { recorded, failed, invariantsPassed: true };
    } catch (error) {
      await this.cleanupTempFiles();
      throw error;
    }
  }
}
