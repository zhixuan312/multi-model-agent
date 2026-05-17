import { z } from 'zod';

export const FINDINGS_OUTCOME_KINDS = ['found', 'clean', 'not_applicable'] as const;
export type FindingsOutcomeKind = typeof FINDINGS_OUTCOME_KINDS[number];

export const findingsOutcomeKindSchema = z.enum(FINDINGS_OUTCOME_KINDS);

export function inferFromFindings(
  findings: readonly { severity: unknown }[],
  legalOutcomes: readonly FindingsOutcomeKind[],
): FindingsOutcomeKind {
  if (findings.length > 0) return 'found';
  // Pick the first non-found legal value (clean for issue-hunters, not_applicable for answer-producers)
  const nonFound = legalOutcomes.find(o => o !== 'found');
  if (!nonFound) throw new Error('legalOutcomes must contain at least one non-found value');
  return nonFound;
}

export function aggregateOutcomes(perTurn: readonly FindingsOutcomeKind[]): FindingsOutcomeKind {
  if (perTurn.length === 0) throw new Error('aggregateOutcomes: empty input');
  if (perTurn.includes('found')) return 'found';
  if (perTurn.includes('not_applicable')) return 'not_applicable';
  return 'clean';
}
