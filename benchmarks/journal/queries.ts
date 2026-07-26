/**
 * Frozen query set used to score retrieval mAP for the journal benchmark.
 *
 * Each query targets the two adopted "expected" landmark nodes that the fixture
 * places at deterministic, seed-independent ids (2*i+1, 2*i+2 for the i-th
 * landmark spec). Because those ids are fixed regardless of seed, the expected
 * sets below are a genuine frozen ground truth.
 */

import { LANDMARK_SPECS } from './fixture-3000.js';

export interface FrozenQuery {
  prompt: string;
  topic?: string;
  expectedNodeIds: string[];
}

function padId(n: number): string {
  return String(n).padStart(4, '0');
}

export const FROZEN_QUERIES: FrozenQuery[] = LANDMARK_SPECS.map((spec, i) => ({
  prompt: spec.prompt,
  topic: spec.topic,
  expectedNodeIds: [padId(2 * i + 1), padId(2 * i + 2)],
}));
