import { appendFileSync } from 'node:fs';

export class VerboseLogChannel {
  constructor(
    private readonly filePath: string,
    private readonly stdout: { write: (s: string) => boolean } = process.stdout,
  ) {}

  emit(event: Record<string, unknown>): void {
    let line: string;
    try {
      line = JSON.stringify({ ...event, atMs: Date.now() }) + '\n';
    } catch {
      line = JSON.stringify({ _serializeError: 'VerboseLogChannel.stringify', atMs: Date.now() }) + '\n';
    }
    try {
      appendFileSync(this.filePath, line);
    } catch {
      // file write failed — still try stdout so the event isn't fully lost
    }
    this.stdout.write(line);
  }
}
