import { createHash } from 'node:crypto';
import { writeFile, readFile, rename, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

const QUEUE_FILE = 'telemetry-queue.ndjson';
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_RECORDS = 10_000;
const CAP_TRUNCATE_COUNT = 1_000;
const MAX_BATCH_READ = 500;

const LOCK_OPTIONS = {
  retries: { retries: 10, minTimeout: 50, maxTimeout: 150, factor: 1.3 },
};

export interface QueueRecord {
  schemaVersion: number;
  installId: string;
  mmaVersion: string;
  os: 'darwin' | 'linux' | 'win32' | 'other';
  nodeMajor: number;
  generation: number;
  events: Record<string, unknown>[];
}

/**
 * What `truncate()` needs to verify a batch before cutting it: where each record starts, and what
 * it hashed to. A `byteLength` sat here too, set on every record and read by nothing — `truncate`
 * compares `sha256` and `byteOffset` and derives the rest from the buffer.
 */
interface RecordMeta {
  byteOffset: number;
  sha256: string;
}

export interface ReadBatchResult {
  records: QueueRecord[];
  meta: RecordMeta[];
}

function deepSort(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSort);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = deepSort((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

function canonicalSerialize(record: QueueRecord): string {
  return JSON.stringify(deepSort(record)) + '\n';
}

function hashLine(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}

async function ensureFile(p: string): Promise<void> {
  if (!existsSync(p)) {
    try {
      await writeFile(p, '', { mode: 0o600, flag: 'wx' });
    } catch {
      // race: another process created it between our check and write
    }
  }
}

export class Queue {
  #queuePath: string;
  /**
   * "Queue is full" is warned once per QUEUE, not once per process.
   *
   * This was a module-level `let capWarned`, with an exported `resetCapWarning()` whose only
   * caller was the test suite's `beforeEach` — production test scaffolding living in production
   * source, and a shared flag besides: a second `Queue` in the same process would never warn,
   * because the first had already spent the one warning for everybody.
   */
  #capWarned = false;
  #approxCount = 0;
  #appendsSinceCapCheck = 0;

  constructor(dir: string) {
    this.#queuePath = join(dir, QUEUE_FILE);
  }

  get queuePath(): string {
    return this.#queuePath;
  }

  async append(record: QueueRecord): Promise<void> {
    // Ensure file exists before locking (proper-lockfile requires it)
    await ensureFile(this.#queuePath);

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.#queuePath, LOCK_OPTIONS);
    } catch {
      return; // lock timeout — silently skip
    }

    try {
      await this.#enforceCap();
      const line = canonicalSerialize(record);

      const fd = await open(this.#queuePath, 'a', 0o600);
      try {
        await fd.write(line);
      } finally {
        await fd.close();
      }

      // fsync skipped here — best-effort, adds significant per-append latency.
      // OS buffers are flushed on process exit; crash recovery is handled by
      // the corruption-rotation path on next readBatch.
    } finally {
      if (release) await release();
    }
  }

  async readBatch(maxRecords = MAX_BATCH_READ): Promise<ReadBatchResult> {
    const records: QueueRecord[] = [];
    const meta: RecordMeta[] = [];

    // Don't create if missing; just return empty
    if (!existsSync(this.#queuePath)) return { records, meta };

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.#queuePath, LOCK_OPTIONS);
    } catch {
      return { records, meta };
    }

    try {
      if (!existsSync(this.#queuePath)) return { records, meta };

      const content = await readFile(this.#queuePath, 'utf8');
      if (!content.trim()) return { records, meta };

      const lines = content.split('\n');
      let byteOffset = 0;

      for (const line of lines) {
        if (records.length >= maxRecords) break;
        if (!line.trim()) {
          byteOffset += Buffer.byteLength(line) + 1;
          continue;
        }

        const lineBytes = line + '\n';
        try {
          const record = JSON.parse(line) as QueueRecord;
          records.push(record);
          meta.push({ byteOffset, sha256: hashLine(lineBytes) });
        } catch {
          // Corrupted line: rotate entire file and stop reading
          await this.#rotateCorrupted();
          return { records, meta: [] };
        }
        byteOffset += Buffer.byteLength(lineBytes);
      }
    } finally {
      if (release) await release();
    }

    return { records, meta };
  }

  /**
   * Remove records whose SHA-256 hashes are in the provided set.
   * Rebuilds the queue file from scratch — safe for arbitrary (non-contiguous)
   * removal. Returns the number of records actually removed.
   */
  async removeRecords(hashes: Set<string>): Promise<number> {
    if (hashes.size === 0) return 0;
    if (!existsSync(this.#queuePath)) return 0;

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.#queuePath, LOCK_OPTIONS);
    } catch {
      return 0;
    }

    try {
      if (!existsSync(this.#queuePath)) return 0;

      const content = await readFile(this.#queuePath, 'utf8');
      const lines = content.split('\n');
      let removed = 0;
      const kept: string[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        const lineBytes = line + '\n';
        if (hashes.has(hashLine(lineBytes))) {
          removed++;
        } else {
          kept.push(line);
        }
      }

      if (removed === 0) return 0;

      const newContent = kept.join('\n') + (kept.length > 0 ? '\n' : '');
      const tmpPath = this.#queuePath + '.rm.' + Date.now();
      await writeFile(tmpPath, newContent, { mode: 0o600 });
      await rename(tmpPath, this.#queuePath);
      return removed;
    } finally {
      if (release) await release();
    }
  }

  async truncate(expectedMeta: RecordMeta[]): Promise<void> {
    if (expectedMeta.length === 0) return;
    if (!existsSync(this.#queuePath)) return;

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.#queuePath, LOCK_OPTIONS);
    } catch {
      return;
    }

    try {
      if (!existsSync(this.#queuePath)) return;

      // Read as a BUFFER. The offsets below are byte offsets — `Buffer.byteLength` of each
      // line — and `String.prototype.slice` indexes UTF-16 code units, not bytes. The two agree
      // only while every queued event is pure ASCII. One `é`, one em dash, one non-Latin
      // character anywhere in an event and `content.slice(byteOffset)` cut mid-record: the
      // remainder began partway through the next line, the following `readBatch` failed to parse
      // it, and `#rotateCorrupted()` discarded EVERY remaining queued event. A successful flush
      // destroyed the rest of the queue, silently, on any install whose telemetry was not
      // entirely ASCII.
      const buf = await readFile(this.#queuePath);
      const content = buf.toString('utf8');
      const lines = content.split('\n');

      // Verify SHA-256 of the first expectedMeta.length records
      let byteOffset = 0;
      let verified = 0;

      for (const line of lines) {
        if (verified >= expectedMeta.length) break;
        if (!line.trim()) {
          byteOffset += Buffer.byteLength(line) + 1;
          continue;
        }

        const lineBytes = line + '\n';
        const actualHash = hashLine(lineBytes);

        if (
          actualHash !== expectedMeta[verified].sha256 ||
          byteOffset !== expectedMeta[verified].byteOffset
        ) {
          return; // hash mismatch — don't truncate
        }

        byteOffset += Buffer.byteLength(lineBytes);
        verified++;
      }

      if (verified === 0) return;

      // Atomically truncate: write remainder to temp file + rename. Sliced on the buffer, at the
      // byte offset the verification loop computed, and written as bytes — no re-encode.
      const remainder = buf.subarray(byteOffset);
      const tmpPath = this.#queuePath + '.tmp.' + Date.now();
      await writeFile(tmpPath, remainder, { mode: 0o600 });
      await rename(tmpPath, this.#queuePath);
    } finally {
      if (release) await release();
    }
  }

  async #enforceCap(): Promise<void> {
    this.#approxCount++;
    this.#appendsSinceCapCheck++;

    // Only check periodically to avoid reading the file on every append
    if (this.#appendsSinceCapCheck < 100 && this.#approxCount < MAX_RECORDS) return;
    this.#appendsSinceCapCheck = 0;

    // Quick size check first
    const st = await stat(this.#queuePath);
    if (st.size <= MAX_SIZE_BYTES && this.#approxCount <= MAX_RECORDS) return;

    // Full check: read the file to get exact record count. A BUFFER, for the same reason as
    // `truncate()` above — `cutOffset` below is a byte offset and must index bytes.
    const capBuf = await readFile(this.#queuePath);
    const content = capBuf.toString('utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const recordCount = lines.length;

    if (st.size <= MAX_SIZE_BYTES && recordCount <= MAX_RECORDS) {
      this.#approxCount = recordCount;
      return;
    }

    if (!this.#capWarned) {
      console.warn(
        'mma-telemetry: queue capped (10 MiB or 10,000 events), dropping oldest 1,000',
      );
      this.#capWarned = true;
    }

    // Compute byte offset to drop exactly CAP_TRUNCATE_COUNT records
    let dropped = 0;
    let cutOffset = 0;
    for (const line of content.split('\n')) {
      if (dropped >= CAP_TRUNCATE_COUNT) break;
      if (!line.trim()) {
        cutOffset += Buffer.byteLength(line) + 1;
        continue;
      }
      cutOffset += Buffer.byteLength(line + '\n');
      dropped++;
    }

    const remainder = capBuf.subarray(cutOffset);
    const tmpPath = this.#queuePath + '.cap.' + Date.now();
    await writeFile(tmpPath, remainder, { mode: 0o600 });
    await rename(tmpPath, this.#queuePath);

    // Reset approximate counter after truncation
    this.#approxCount = Math.max(0, recordCount - CAP_TRUNCATE_COUNT);
  }

  async #rotateCorrupted(): Promise<void> {
    const ts = Date.now();
    const corruptedPath = this.#queuePath.replace('.ndjson', `.corrupted-${ts}.ndjson`);
    await rename(this.#queuePath, corruptedPath);
    await writeFile(this.#queuePath, '', { mode: 0o600 });
  }
}

