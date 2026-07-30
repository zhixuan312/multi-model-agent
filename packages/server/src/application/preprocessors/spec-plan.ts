import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveComponents, type SkillPair } from '@zhixuan92/multi-model-agent-core';
import { deriveDefaultOutputPath } from './derive-output-path.js';
import { PreprocessFailure, type Preprocessor, type PreprocessResult } from './types.js';

/**
 * Spec/Plan shared pre-processing: outputPath validation + derivation, plus a resolvability
 * preflight over ALL target.paths.
 *
 * The preflight survives the removal of worktrees even though the copying it used to feed does
 * not: workers now read these paths directly out of the caller's cwd, so nothing needs copying,
 * but failing fast on a missing / unreadable / broken-symlink input is still far better than
 * letting a worker discover it mid-turn and improvise around it.
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

  if (hasPaths) {
    const unresolvable = spPayload.target!.paths!.find(
      (filePath) => !fs.existsSync(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)),
    );
    if (unresolvable !== undefined) {
      throw new PreprocessFailure('invalid_request', `target.paths contains an unresolvable path: ${unresolvable}`);
    }
  }

  return {};
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
