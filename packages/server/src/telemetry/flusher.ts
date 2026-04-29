import { gzipSync } from 'node:zlib';
import { Queue } from './queue.js';
import { readGeneration } from './generation.js';
import { getOrCreateIdentity, sign } from './identity.js';
import type { ReadBatchResult } from './queue.js';

export interface FlusherOptions {
  queue: Queue;
  dir: string;
  endpoint: string;
}

const MAX_BATCH = 500;
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BOOT_DELAY_MS = 5_000; // 5 seconds
const QUEUE_SIZE_TRIGGER = 100;
const DRAIN_BUDGET_MS = 2_000; // 2 seconds
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour cap
const NO_RETRY_AFTER_DEFAULT = 60 * 60 * 1000; // 1 hour
const INITIAL_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

function groupKey(record: {
  schemaVersion: number;
  installId: string;
  mmagentVersion: string;
  os: string;
  nodeMajor: number;
  generation: number;
}): string {
  return `${record.schemaVersion}|${record.installId}|${record.mmagentVersion}|${record.os}|${record.nodeMajor}|${record.generation}`;
}

interface UploadResult {
  status: '204' | '400' | '413' | '429' | '5xx' | 'network';
  retryAfterSeconds: number | null;
}

export class Flusher {
  #queue: Queue;
  #dir: string;
  #endpoint: string;
  #controller: AbortController;
  #timer: ReturnType<typeof setInterval> | null = null;
  #bootTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 0;
  #inFlight = false;
  #dropped = 0;

  constructor(opts: FlusherOptions) {
    this.#queue = opts.queue;
    this.#dir = opts.dir;
    this.#endpoint = opts.endpoint;
    this.#controller = new AbortController();
  }

  get controller(): AbortController {
    return this.#controller;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get backoffActive(): boolean {
    return this.#backoffTimer !== null;
  }

  start(): void {
    this.#timer = setInterval(() => {
      if (!this.#inFlight && !this.backoffActive) {
        this.flush().catch(() => {});
      }
    }, INTERVAL_MS);
    this.#timer.unref();

    this.#bootTimer = setTimeout(() => {
      this.#bootTimer = null;
      this.flush().catch(() => {});
    }, BOOT_DELAY_MS);
    this.#bootTimer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#bootTimer) {
      clearTimeout(this.#bootTimer);
      this.#bootTimer = null;
    }
    this.clearBackoff();
    this.#controller.abort();
  }

  async drain(): Promise<void> {
    this.stop();
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    const drainSignal = AbortSignal.timeout(DRAIN_BUDGET_MS);

    try {
      await this.#doFlush(drainSignal, deadline);
    } catch {
      // drain is best-effort
    }
  }

  async flush(): Promise<void> {
    if (this.#inFlight) return;
    if (this.backoffActive) return;
    return this.#doFlush(this.#controller.signal);
  }

  async #doFlush(signal: AbortSignal, deadline?: number): Promise<void> {
    if (signal.aborted) return;
    this.#inFlight = true;

    try {
      // Step 1: read up to 500 records + capture generation snapshot
      const batch: ReadBatchResult = await this.#queue.readBatch(MAX_BATCH);
      if (batch.records.length === 0) return;

      const genSnapshot = readGeneration(this.#dir);

      // Step 4: Group consecutive records by (schemaVersion, install, generation)
      const groups: { records: ReadBatchResult['records']; meta: ReadBatchResult['meta'] }[] = [];
      let currentKey = '';
      let currentRecords: ReadBatchResult['records'] = [];
      let currentMeta: ReadBatchResult['meta'] = [];

      for (let i = 0; i < batch.records.length; i++) {
        const key = groupKey(batch.records[i]);
        if (currentKey && key !== currentKey) {
          groups.push({ records: currentRecords, meta: currentMeta });
          currentRecords = [];
          currentMeta = [];
        }
        currentKey = key;
        currentRecords.push(batch.records[i]);
        currentMeta.push(batch.meta[i]);
      }
      if (currentRecords.length > 0) {
        groups.push({ records: currentRecords, meta: currentMeta });
      }

      // Steps 5-6: Process each batch in order
      let acknowledgedCount = 0;
      let shouldBackoff = false;
      let backoffDuration = 0;

      for (const group of groups) {
        if (deadline && Date.now() > deadline) break;

        // Re-check generation; if changed since read, abort
        const currentGen = readGeneration(this.#dir);
        if (currentGen !== genSnapshot) break;

        if (signal.aborted) break;

        const result = await this.#uploadBatch(group, signal);

        if (result.status === '204' || result.status === '400' || result.status === '413') {
          acknowledgedCount += group.records.length;
          if (result.status === '400' || result.status === '413') {
            this.#dropped += group.records.length;
          }
        } else {
          shouldBackoff = true;
          if (result.status === '429') {
            backoffDuration = result.retryAfterSeconds !== null
              ? result.retryAfterSeconds * 1000
              : NO_RETRY_AFTER_DEFAULT;
          } else {
            backoffDuration = this.#nextBackoff();
          }
          break; // stop iterating on non-success
        }
      }

      // Steps 7-9: truncate acknowledged prefix
      if (acknowledgedCount > 0) {
        await this.#queue.truncate(batch.meta.slice(0, acknowledgedCount));
      }

      // Apply or clear backoff
      if (shouldBackoff) {
        this.#scheduleBackoff(backoffDuration);
      } else {
        // Reset backoff on successful drain (all batches processed)
        this.clearBackoff();
      }
    } finally {
      this.#inFlight = false;
    }
  }

  async #uploadBatch(
    group: { records: ReadBatchResult['records']; meta: ReadBatchResult['meta'] },
    signal: AbortSignal,
  ): Promise<UploadResult> {
    const first = group.records[0];
    const events = group.records.flatMap(r => r.events);
    const jsonBody = JSON.stringify({
      schemaVersion: first.schemaVersion,
      installId: first.installId,
      mmagentVersion: first.mmagentVersion,
      os: first.os,
      nodeMajor: first.nodeMajor,
      events,
    });
    const identity = getOrCreateIdentity(this.#dir);
    const signature = sign(identity.privateKeyPkcs8, jsonBody);
    const body = gzipSync(Buffer.from(jsonBody, 'utf8'));

    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/json',
          'X-Mmagent-Install-Id': identity.installId,
          'X-Mmagent-Signature': signature,
          'X-Mmagent-Pubkey': identity.publicKeyRaw,
        },
        body,
        signal,
      });

      const status = response.status;
      if (status === 204) return { status: '204', retryAfterSeconds: null };
      if (status === 400) return { status: '400', retryAfterSeconds: null };
      if (status === 413) return { status: '413', retryAfterSeconds: null };
      if (status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const seconds = retryAfter ? parseInt(retryAfter, 10) : null;
        return { status: '429', retryAfterSeconds: Number.isFinite(seconds) ? seconds as number : null };
      }
      if (status >= 500) return { status: '5xx', retryAfterSeconds: null };

      // Unexpected status: treat as 5xx
      return { status: '5xx', retryAfterSeconds: null };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      return { status: 'network', retryAfterSeconds: null };
    }
  }

  #nextBackoff(): number {
    if (this.#backoffMs === 0) {
      this.#backoffMs = INITIAL_BACKOFF_MS;
    } else {
      this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    }
    return this.#backoffMs;
  }

  #scheduleBackoff(ms: number): void {
    this.clearBackoff();
    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = null;
      this.#backoffMs = 0;
      this.flush().catch(() => {});
    }, ms);
    if (this.#backoffTimer.unref) this.#backoffTimer.unref();
  }

  clearBackoff(): void {
    if (this.#backoffTimer) {
      clearTimeout(this.#backoffTimer);
      this.#backoffTimer = null;
    }
    this.#backoffMs = 0;
  }
}
