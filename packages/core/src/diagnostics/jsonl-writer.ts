import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export interface JsonlWriterOptions {
  dir: string;
  openSync?: typeof nodeFs.openSync;
  writeSync?: typeof nodeFs.writeSync;
  closeSync?: typeof nodeFs.closeSync;
  mkdirSync?: typeof nodeFs.mkdirSync;
  now?: () => Date;
}

export class JsonlWriter {
  private fd: number | null = null;
  private currentDate: string | null = null;
  private readonly dir: string;
  private readonly openSync: typeof nodeFs.openSync;
  private readonly writeSync: typeof nodeFs.writeSync;
  private readonly closeSync: typeof nodeFs.closeSync;
  private readonly now: () => Date;

  constructor(opts: JsonlWriterOptions) {
    this.dir = process.env.MMAGENT_LOG_DIR ?? opts.dir;
    this.openSync = opts.openSync ?? nodeFs.openSync;
    this.writeSync = opts.writeSync ?? nodeFs.writeSync;
    this.closeSync = opts.closeSync ?? nodeFs.closeSync;
    this.now = opts.now ?? (() => new Date());
    (opts.mkdirSync ?? nodeFs.mkdirSync)(this.dir, { recursive: true });
  }

  private filenameFor(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `mmagent-${yyyy}-${mm}-${dd}.jsonl`;
  }

  writeLine(record: Record<string, unknown>): void {
    const dateKey = this.filenameFor(this.now());
    if (this.currentDate !== dateKey) {
      if (this.fd !== null) { try { this.closeSync(this.fd); } catch { /* rotate */ } }
      this.fd = this.openSync(join(this.dir, dateKey), 'a');
      this.currentDate = dateKey;
    }
    if (this.fd === null) return;
    try { this.writeSync(this.fd, JSON.stringify(record) + '\n'); }
    catch { /* swallow write errors */ }
  }

  get currentPath(): string {
    return join(this.dir, this.filenameFor(this.now()));
  }

  close(): void {
    if (this.fd !== null) { try { this.closeSync(this.fd); } catch { /* best effort */ } this.fd = null; }
  }
}
