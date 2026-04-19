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
 * Check whether any output targets are still missing on disk.
 * Returns true if any target does not exist.
 */
export function checkOutputTargets(outputTargets: string[]): boolean {
  if (outputTargets.length === 0) return false;
  return outputTargets.some(t => !existsSync(t));
}