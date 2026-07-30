import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveComponents, type SkillPair } from '@zhixuan92/multi-model-agent-core';
import { deriveDefaultOutputPath } from './derive-output-path.js';
import { PreprocessFailure, type Preprocessor, type PreprocessResult } from './types.js';

/**
 * Spec/Plan shared pre-processing: outputPath validation + derivation, and
 * copyToWorktree for ALL target.paths so the worker reads every input (e.g.
 * the dated exploration it is named after), not just paths[0]. Each entry must
 * resolve BEFORE dispatch — any missing / unreadable / broken-symlink path
 * fails the task; no partial copyToWorktree is produced.
 */
function preprocessSpecPlan(
  type: 'spec' | 'plan',
  cwd: string,
  payload: Record<string, unknown>,
): PreprocessResult {
  const spPayload = payload as { prompt: string; target?: { paths?: string[]; inline?: string }; outputPath?: string };
  const hasInline = spPayload.target?.inline !== undefined;
  const hasPaths = spPayload.target?.paths !== undefined && spPayload.target.paths.length > 0;

  // Validate outputPath if provided
  if (spPayload.outputPath) {
    if (spPayload.outputPath.includes('..') || path.isAbsolute(spPayload.outputPath)) {
      throw new PreprocessFailure('invalid_output_path', `outputPath must be relative to cwd and must not contain '..': ${spPayload.outputPath}`);
    }
  }

  // For plan + inline, outputPath is required
  if (type === 'plan' && hasInline && !spPayload.outputPath) {
    throw new PreprocessFailure('invalid_request', 'outputPath is required when type=plan uses target.inline (cannot derive basename from inline content)');
  }

  // Derive outputPath if not provided (defaults live under .mma/,
  // alongside the journal — see derive-output-path.ts)
  if (!spPayload.outputPath) {
    const today = new Date().toISOString().slice(0, 10);
    const derived = deriveDefaultOutputPath({
      type,
      prompt: spPayload.prompt,
      paths: hasPaths ? spPayload.target!.paths! : undefined,
      today,
    });
    if (derived) (payload as Record<string, unknown>).outputPath = derived;
  }

  let copyToWorktree: string[] | undefined;
  if (hasPaths) {
    const allPaths = spPayload.target!.paths!;
    const unresolvable = allPaths.find(
      (filePath) => !fs.existsSync(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)),
    );
    if (unresolvable !== undefined) {
      throw new PreprocessFailure('invalid_request', `target.paths contains an unresolvable path: ${unresolvable}`);
    }
    copyToWorktree = allPaths.map((filePath) =>
      path.isAbsolute(filePath)
        ? path.relative(fs.realpathSync(cwd), fs.realpathSync(path.resolve(cwd, filePath)))
        : filePath,
    );
  }

  return copyToWorktree ? { copyToWorktree } : {};
}

export const planPreprocessor: Preprocessor = async ({ cwd, payload }) =>
  preprocessSpecPlan('plan', cwd, payload);

function buildSpecScopeInstruction(rawComponents: unknown): string {
  const resolved = resolveComponents(rawComponents as Parameters<typeof resolveComponents>[0]);
  return `Emit only these spec components, in canonical order: ${resolved.join(', ')}.`;
}

/** Spec adds component resolution + scope injection on top of the shared logic. */
export const specPreprocessor: Preprocessor = async ({ cwd, payload, input, skills }) => {
  const base = preprocessSpecPlan('spec', cwd, payload);

  const rawComponents = (input as Record<string, unknown>).components;
  (payload as Record<string, unknown>).components = resolveComponents(
    rawComponents as Parameters<typeof resolveComponents>[0],
  );
  const scopeInstruction = `\n\n## Requested Spec Components\n\n${buildSpecScopeInstruction(rawComponents)}\n`;
  const amendedSkills: SkillPair = {
    implement: `${skills.implement}${scopeInstruction}`,
    review: `${skills.review}${scopeInstruction}`,
  };

  return { ...base, skills: amendedSkills };
};
