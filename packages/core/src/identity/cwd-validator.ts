import { realpathSync, existsSync } from 'node:fs';
import { resolve, sep, dirname, basename } from 'node:path';

export class CWDValidator {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = realpathSync(resolve(cwd));
  }

  validate(target: string): string {
    const absTarget = resolve(this.cwd, target);
    // For non-existent targets (e.g. write_file creating a new file),
    // resolve the parent's realpath instead so symlink confinement still
    // works but we don't ENOENT on the create.
    let resolved: string;
    if (existsSync(absTarget)) {
      resolved = realpathSync(absTarget);
    } else {
      const parent = dirname(absTarget);
      const parentReal = existsSync(parent) ? realpathSync(parent) : parent;
      resolved = resolve(parentReal, basename(absTarget));
    }
    if (resolved !== this.cwd && !resolved.startsWith(this.cwd + sep)) {
      throw new Error(`path escapes cwd: ${target}`);
    }
    return resolved;
  }
}
