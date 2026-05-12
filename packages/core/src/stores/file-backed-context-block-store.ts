/**
 * FileBackedContextBlockStore — disk-backed implementation of
 * `ContextBlockStore` so context blocks survive daemon restarts.
 *
 * Per the wire-telemetry-gaps plan, Gap 4: round-over-round audit is the
 * documented use case for context blocks; a memory-only store loses
 * everything on `npm run serve` cycles, breaking the recipe. This store
 * persists to disk and reloads lazily on first access.
 *
 * Layout: `<homeDir>/.multi-model/context-blocks/<sha256(projectCwd)>/<id>.txt`
 * (content) + `<id>.meta.json` ({ createdAt, ttlMs, lengthChars, sha256 }).
 * Storing in the user home (not the project tree) keeps repos clean —
 * no `.gitignore` entries needed — while the per-project hash subdir
 * preserves project isolation.
 *
 * Operational properties:
 *   - **Authoritative cwd**: per-project subdir is `sha256(path.resolve(projectCwd))`.
 *     NOT daemon cwd, NOT task cwd.
 *   - **Permissions**: directories `0700`, files `0600`. Audit findings
 *     can carry sensitive code excerpts; user-only access by default.
 *   - **TTL**: 7 days default. Enforced on `get()` (lazy delete on
 *     stale read), at the start of `register()` (opportunistic GC if
 *     last sweep was over `gcCheckIntervalMs` ago), and via
 *     `runIdleSweep()` for periodic timer-driven sweeps.
 *   - **Size caps**: per-block 1 MiB, per-store 100 MiB total — measured
 *     via `Buffer.byteLength(content, 'utf8')` so multi-byte content
 *     can't sneak past the cap. Oldest-first eviction when total cap
 *     is exceeded.
 *   - **Atomic writes**: temp-file → fsync → rename. GC treats orphaned
 *     pairs (content without metadata or vice versa) as corrupt and
 *     deletes both — recovers cleanly from daemon SIGKILL mid-write.
 *
 * Pinning is a no-op on this implementation — disk persistence is
 * stronger than the in-memory pin contract. The `pin`/`unpin` methods
 * exist on the interface for API symmetry and to satisfy the LRU-skip
 * contract that batch-registry expects, but disk eviction always
 * respects TTL only.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ContextBlockStore,
  type RegisteredBlock,
} from './context-block-tool.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_BLOCK_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

interface DiskMeta {
  createdAt: number;
  ttlMs: number;
  lengthChars: number;
  sha256: string;
}

export interface FileBackedContextBlockStoreOptions {
  /** Idle TTL in milliseconds. Defaults to 7 days. */
  ttlMs?: number;
  /** How often `register()` opportunistically sweeps. Defaults to 1 hour. */
  gcCheckIntervalMs?: number;
  /** Max bytes per block (UTF-8). Defaults to 1 MiB. */
  maxBlockBytes?: number;
  /** Max total bytes on disk. Defaults to 100 MiB. */
  maxTotalBytes?: number;
  /** Override `os.homedir()` — used by tests for filesystem isolation. */
  homeDir?: string;
  maxBlocksPerProject?: number;
}

export class FileBackedContextBlockStore implements ContextBlockStore {
  /** Absolute root: `<homeDir>/.multi-model/context-blocks/<sha256(projectCwd)>`.
   *  Public so tests can read meta files directly without re-deriving the path. */
  readonly rootDir: string;
  private _ttlMs: number;
  private gcCheckIntervalMs: number;
  private maxBlockBytes: number;
  private maxTotalBytes: number;
  private lastSweepMs = 0;
  /** Pin counts are kept in memory only — they're an active-batch
   *  protection signal, not a persistence concern. Lost on restart;
   *  TTL-based GC handles the recovery side. */
  private pinCounts = new Map<string, number>();
  private readonly maxBlocksPerProject: number;

  constructor(projectCwd: string, opts: FileBackedContextBlockStoreOptions = {}) {
    const home = opts.homeDir ?? os.homedir();
    let canonical: string;
    try {
      canonical = fs.realpathSync(path.resolve(projectCwd));
    } catch {
      // Path doesn't exist on disk yet — fall back to absolute. The store is
      // still usable for callers who pass a future cwd; symlink-collapse
      // semantics only kick in once the path exists.
      canonical = path.resolve(projectCwd);
    }
    const projectHash = createHash('sha256').update(canonical).digest('hex');
    this.rootDir = path.join(home, '.multi-model', 'context-blocks', projectHash);
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.gcCheckIntervalMs = opts.gcCheckIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.maxBlockBytes = opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxBlocksPerProject = opts.maxBlocksPerProject ?? 500;
    this.ensureRoot();
  }

  register(content: string, opts: { ttlMs?: number; id?: string } = {}): RegisteredBlock {
    const sha256 = createHash('sha256').update(content).digest('hex');
    // 4.2.3+: fall back to the class-level _ttlMs default (configured at
    // construction) rather than a hardcoded constant. Earlier draft of
    // the plan literally said `?? 28_800_000` which broke the
    // "lazy-deletes on get when entry is past TTL" pre-existing test —
    // that test constructs the store with `ttlMs: 1` and then calls
    // `register('x')` (no opts), expecting the per-call TTL to inherit
    // the class default.
    const ttlMs = opts.ttlMs ?? this._ttlMs;
    
    // DEDUPE: look for existing block in this project with matching content sha
    if (!opts.id) {
      const existing = this.findByContentSha(sha256);
      if (existing) {
        // Bump mtime + reset TTL on the existing block
        const now = Date.now();
        const metaContent = JSON.parse(fs.readFileSync(this.metaPath(existing), 'utf8'));
        metaContent.ttlMs = ttlMs;
        metaContent.createdAt = now;
        fs.writeFileSync(this.metaPath(existing), JSON.stringify(metaContent), { mode: 0o600 });
        fs.utimesSync(this.contentPath(existing), now / 1000, now / 1000);
        fs.utimesSync(this.metaPath(existing), now / 1000, now / 1000);
        return { id: existing, lengthChars: content.length, sha256 };
      }
    }

    const byteSize = Buffer.byteLength(content, 'utf8');
    if (byteSize > this.maxBlockBytes) {
      throw new Error(
        `Context block exceeds per-block cap of ${this.maxBlockBytes} bytes (got ${byteSize}).`,
      );
    }

    const id = opts.id ?? randomUUID();
    const now = Date.now();
    const meta: DiskMeta = {
      createdAt: now,
      ttlMs,
      lengthChars: content.length,
      sha256,
    };

    // Opportunistic GC + size-cap enforcement before we write.
    if (now - this.lastSweepMs > this.gcCheckIntervalMs) {
      this.runIdleSweep(now, this._ttlMs);
      this.lastSweepMs = now;
    }
    this.evictUntilFits(byteSize);

    this.sweepInnerLruIfNeeded();

    this.atomicWrite(this.contentPath(id), content);
    this.atomicWrite(this.metaPath(id), JSON.stringify(meta) + '\n');

    return { id, lengthChars: content.length, sha256 };
  }

  get(id: string): string | undefined {
    const meta = this.readMeta(id);
    if (!meta) return undefined;

    const now = Date.now();
    if (now - meta.createdAt > meta.ttlMs) {
      // Expired: lazy-delete (matches in-memory store semantics)
      this.deleteFiles(id);
      return undefined;
    }

    try {
      return fs.readFileSync(this.contentPath(id), 'utf8');
    } catch {
      // Content missing but meta present — orphan; clean up.
      this.deleteFiles(id);
      return undefined;
    }
  }

  delete(id: string): boolean {
    const existed = fs.existsSync(this.contentPath(id)) || fs.existsSync(this.metaPath(id));
    this.deleteFiles(id);
    this.pinCounts.delete(id);
    return existed;
  }

  pin(id: string): void {
    this.pinCounts.set(id, (this.pinCounts.get(id) ?? 0) + 1);
  }

  unpin(id: string): void {
    const cur = this.pinCounts.get(id) ?? 0;
    if (cur <= 1) this.pinCounts.delete(id);
    else this.pinCounts.set(id, cur - 1);
  }

  refcount(id: string): number {
    return this.pinCounts.get(id) ?? 0;
  }

  runIdleSweep(now: number, idleTtlMs: number): number {
    let evicted = 0;
    for (const id of this.listIds()) {
      if ((this.pinCounts.get(id) ?? 0) > 0) continue;
      const meta = this.readMeta(id);
      if (!meta) {
        // Orphan content (no meta) — corrupt half-write recovery
        this.deleteFiles(id);
        evicted++;
        continue;
      }
      // Use the entry's stored ttlMs (may differ from caller's idleTtlMs)
      // OR caller's idleTtlMs, whichever is shorter — caller wins for
      // explicit forced sweeps.
      const effectiveTtl = Math.min(meta.ttlMs, idleTtlMs);
      if (now - meta.createdAt > effectiveTtl) {
        this.deleteFiles(id);
        evicted++;
      }
    }
    return evicted;
  }

  get ttlMs(): number {
    return this._ttlMs;
  }

  /** Number of entries currently on disk (counted by id, not by file —
   *  orphan halves count once). */
  get size(): number {
    return this.listIds().length;
  }

  /** Delete every block. Used by project-registry on idle eviction. */
  clear(): void {
    for (const id of this.listIds()) this.deleteFiles(id);
    this.pinCounts.clear();
  }

  /** Sum of all on-disk content bytes (no caching — fresh read each call).
   *  Used by tests + `evictUntilFits`. */
  totalBytesOnDisk(): number {
    let total = 0;
    for (const id of this.listIds()) {
      try {
        total += fs.statSync(this.contentPath(id)).size;
      } catch {
        // missing file — skip
      }
    }
    return total;
  }

  // ── private helpers ────────────────────────────────────────────────

  private ensureRoot(): void {
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
  }

  private contentPath(id: string): string {
    return path.join(this.rootDir, `${id}.txt`);
  }

  private metaPath(id: string): string {
    return path.join(this.rootDir, `${id}.meta.json`);
  }

  private listIds(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.rootDir);
    } catch {
      return [];
    }
    const ids = new Set<string>();
    for (const name of entries) {
      if (name.endsWith('.meta.json')) ids.add(name.slice(0, -'.meta.json'.length));
      else if (name.endsWith('.txt')) ids.add(name.slice(0, -'.txt'.length));
    }
    return [...ids];
  }

  private readMeta(id: string): DiskMeta | undefined {
    try {
      const raw = fs.readFileSync(this.metaPath(id), 'utf8');
      const parsed = JSON.parse(raw) as DiskMeta;
      if (
        typeof parsed.createdAt === 'number'
        && typeof parsed.ttlMs === 'number'
        && typeof parsed.lengthChars === 'number'
        && typeof parsed.sha256 === 'string'
      ) {
        return parsed;
      }
    } catch {
      // unreadable / corrupt
    }
    return undefined;
  }

  private deleteFiles(id: string): void {
    try { fs.unlinkSync(this.contentPath(id)); } catch { /* ignore */ }
    try { fs.unlinkSync(this.metaPath(id)); } catch { /* ignore */ }
  }

  /**
   * Atomic write: temp-file → fsync → rename. Recovers cleanly from
   * daemon SIGKILL mid-write — readers either see the old content or
   * the new content, never a partial write. The .tmp suffix uses a
   * random nonce so concurrent writers don't collide.
   *
   * Defensive: `ensureRoot()` runs once at construction, but the
   * rootDir can disappear between construction and write — e.g. an
   * external rm, a maintenance script, or (historically) a startup-time
   * project-cap sweep that ran in a different process. Re-creating the
   * dir here is idempotent and cheap; the alternative is an ENOENT that
   * crashes the entire batch and burns its findings.
   */
  private atomicWrite(targetPath: string, content: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, targetPath);
  }

  /** TTL pass first; if still at or above maxBlocksPerProject, evict oldest-mtime block(s) until under cap. */
  private sweepInnerLruIfNeeded(): void {
    if (!fs.existsSync(this.rootDir)) return;
    // TTL pass
    const now = Date.now();
    const files = fs.readdirSync(this.rootDir);
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.rootDir, file), 'utf8'));
        if (typeof meta.createdAt === 'number' && typeof meta.ttlMs === 'number' && now > meta.createdAt + meta.ttlMs) {
          const id = file.slice(0, -'.meta.json'.length);
          try { fs.unlinkSync(path.join(this.rootDir, `${id}.txt`)); } catch {}
          try { fs.unlinkSync(path.join(this.rootDir, `${id}.meta.json`)); } catch {}
        }
      } catch { /* skip malformed */ }
    }
    // LRU pass
    let blockIds = fs.readdirSync(this.rootDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => f.slice(0, -'.txt'.length));
    while (blockIds.length >= this.maxBlocksPerProject) {
      // Find oldest-mtime block
      let oldestId: string | null = null;
      let oldestMtime = Infinity;
      for (const id of blockIds) {
        try {
          const m = fs.statSync(path.join(this.rootDir, `${id}.txt`)).mtimeMs;
          if (m < oldestMtime) { oldestMtime = m; oldestId = id; }
        } catch { /* skip */ }
      }
      if (!oldestId) break;
      try { fs.unlinkSync(path.join(this.rootDir, `${oldestId}.txt`)); } catch {}
      try { fs.unlinkSync(path.join(this.rootDir, `${oldestId}.meta.json`)); } catch {}
      blockIds = blockIds.filter(i => i !== oldestId);
    }
  }

  /**
   * Oldest-first eviction loop until total disk usage + incoming bytes
   * fits under maxTotalBytes. Pinned entries are skipped (matches
   * in-memory store semantics — pinned blocks are held by an active
   * batch and shouldn't be evicted mid-run).
   */
  private evictUntilFits(incomingBytes: number): void {
    let total = this.totalBytesOnDisk();
    if (total + incomingBytes <= this.maxTotalBytes) return;

    type Candidate = { id: string; createdAt: number; bytes: number };
    const candidates: Candidate[] = [];
    for (const id of this.listIds()) {
      if ((this.pinCounts.get(id) ?? 0) > 0) continue;
      const meta = this.readMeta(id);
      if (!meta) continue;
      let bytes = 0;
      try { bytes = fs.statSync(this.contentPath(id)).size; } catch { continue; }
      candidates.push({ id, createdAt: meta.createdAt, bytes });
    }
    // Oldest-first
    candidates.sort((a, b) => a.createdAt - b.createdAt);

    for (const c of candidates) {
      if (total + incomingBytes <= this.maxTotalBytes) break;
      this.deleteFiles(c.id);
      total -= c.bytes;
    }
  }

  /** Scan this project's meta files for one whose recorded sha256 matches `sha256`. Returns the id, or null. */
  private findByContentSha(sha256: string): string | null {
    if (!fs.existsSync(this.rootDir)) return null;
    const files = fs.readdirSync(this.rootDir);
    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.rootDir, file), 'utf8'));
        if (meta.sha256 === sha256) return file.slice(0, -'.meta.json'.length);
      } catch {
        // Skip malformed meta files
      }
    }
    return null;
  }
}
