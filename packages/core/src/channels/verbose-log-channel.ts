import { appendFileSync } from 'node:fs';

export class VerboseLogChannel {
  constructor(private filePath: string, private stdout = process.stdout) {}
  emit(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ...event, atMs: Date.now() }) + '\n';
    appendFileSync(this.filePath, line);
    this.stdout.write(line);
  }
}
