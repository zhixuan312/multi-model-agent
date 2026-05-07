import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export class CWDValidator {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = realpathSync(resolve(cwd));
  }

  validate(target: string): string {
    const resolved = realpathSync(resolve(this.cwd, target));
    if (resolved !== this.cwd && !resolved.startsWith(this.cwd + sep)) {
      throw new Error(`path escapes cwd: ${target}`);
    }
    return resolved;
  }
}
