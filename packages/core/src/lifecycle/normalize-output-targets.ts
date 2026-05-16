import { resolve } from 'node:path';

export function normalizeOutputTargets(targets: string[] | undefined, cwd: string): string[] {
  if (!targets || targets.length === 0) return [];
  const absCwd = resolve(cwd);
  return targets.map((t) => {
    const abs = resolve(absCwd, t);
    if (!abs.startsWith(absCwd + '/') && abs !== absCwd) {
      throw new Error(`output_targets_invalid: ${t} escapes cwd`);
    }
    return abs;
  });
}
