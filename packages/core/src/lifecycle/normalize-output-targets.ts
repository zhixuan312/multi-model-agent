import { resolve, sep } from 'node:path';

export function normalizeOutputTargets(targets: string[] | undefined, cwd: string): string[] {
  if (!targets || targets.length === 0) return [];
  const absCwd = resolve(cwd);
  return targets.map((t) => {
    const abs = resolve(absCwd, t);
    // Use the platform separator (not a hardcoded '/') so the under-cwd check
    // holds on Windows, where resolve() yields backslash paths.
    if (!abs.startsWith(absCwd + sep) && abs !== absCwd) {
      throw new Error(`output_targets_invalid: ${t} escapes cwd`);
    }
    return abs;
  });
}
