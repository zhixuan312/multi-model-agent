import { existsSync } from 'fs';
import { resolve } from 'path';

export interface FilePathPartition {
  outputTargets: string[];
}

/**
 * Partition filePaths into existing (inputs) and non-existing (output targets).
 * Output targets are resolved to absolute paths.
 */
export function partitionFilePaths(
  filePaths: string[] | undefined,
  cwd: string,
): FilePathPartition {
  if (!filePaths || filePaths.length === 0) return { outputTargets: [] };

  const outputTargets: string[] = [];
  for (const fp of filePaths) {
    const abs = resolve(cwd, fp);
    if (!existsSync(abs)) {
      outputTargets.push(abs);
    }
  }
  return { outputTargets };
}

/**
 * Returns the subset of `outputTargets` that do NOT exist on disk.
 * Empty array means all targets exist. Caller decides whether non-empty
 * is a failure (typically yes — surface as a structured finding).
 */
export function checkOutputTargets(outputTargets: string[]): string[] {
  return outputTargets.filter((p) => !existsSync(p));
}