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
}

export class FileBackedContextBlockStore implements ContextBlockStore {
  /** Absolute root: `<homeDir>/.multi-model-agent/context-blocks/<sha256(projectCwd)>`.
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

  constructor(projectCwd: string, opts: FileBackedContextBlockStoreOptions = {}) {
    const home = opts.homeDir ?? os.homedir();
    const projectHash = createHash('sha256').update(path.resolve(projectCwd)).digest('hex');
    this.rootDir = path.join(home, '.multi-model', 'context-blocks', projectHash);
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.gcCheckIntervalMs = opts.gcCheckIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.maxBlockBytes = opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.ensureRoot();
  }

  register(content: string, opts: { id?: string } = {}): RegisteredBlock {
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (byteSize > this.maxBlockBytes) {
      throw new Error(
        `Context block exceeds per-block cap of ${this.maxBlockBytes} bytes (got ${byteSize}).`,
      );
    }

    const id = opts.id ?? randomUUID();
    const now = Date.now();
    const sha256 = createHash('sha256').update(content).digest('hex');
    const meta: DiskMeta = {
      createdAt: now,
      ttlMs: this._ttlMs,
      lengthChars: content.length,
      sha256,
    };

    // Opportunistic GC + size-cap enforcement before we write.
    if (now - this.lastSweepMs > this.gcCheckIntervalMs) {
      this.runIdleSweep(now, this._ttlMs);
      this.lastSweepMs = now;
    }
    this.evictUntilFits(byteSize);

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
   */
  private atomicWrite(targetPath: string, content: string): void {
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
}
