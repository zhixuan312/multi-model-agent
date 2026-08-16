/**
 * PRIVACY.md's stated schema version must be the one the wire actually stamps.
 *
 * `privacy-doc-sync.test.ts` enforces FIELD-NAME sync and passed throughout, because every v7
 * field was documented. What it cannot see is prose: the document's header said
 * "**Schema version: 6**", its `schemaVersion` row said "integer literal `6`", and
 * `wire-schema.ts` had said `SCHEMA_VERSION = 7` since 6.10.0. A privacy document that names the
 * wrong schema version is describing a different wire than the one shipping.
 *
 * The release runbook already warns about exactly this — "a contract test enforces field-name
 * sync, but it cannot catch stale prose — read it whenever the release touched telemetry" — which
 * is a manual step, and manual steps are the ones that get skipped. This is the mechanical half.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../../packages/core/src/events/wire-schema.js';

const PRIVACY = readFileSync('PRIVACY.md', 'utf8');

describe('PRIVACY.md tracks the wire schema version', () => {
  it('the wire version is a real number', () => {
    // Floor: if this stops resolving, every assertion below is comparing against undefined.
    expect(typeof SCHEMA_VERSION).toBe('number');
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('the header states the current schema version', () => {
    expect(PRIVACY, `PRIVACY.md header does not say "Schema version: ${SCHEMA_VERSION}"`)
      .toContain(`**Schema version: ${SCHEMA_VERSION}**`);
  });

  it('the schemaVersion field row states the current literal', () => {
    const row = PRIVACY.split('\n').find((l) => l.startsWith('| `schemaVersion` |'));
    expect(row, 'no `schemaVersion` row found in the field table').toBeDefined();
    expect(row, `the schemaVersion row does not name integer literal \`${SCHEMA_VERSION}\``)
      .toContain(`integer literal \`${SCHEMA_VERSION}\``);
  });

  it('the changelog table has a row for the current schema version', () => {
    // A bump without a history row leaves a reader unable to tell what changed in the vocabulary.
    const rows = PRIVACY.split('\n').filter((l) => /^\| \d{4}-\d{2}-\d{2} \| \d+ \|/.test(l));
    expect(rows.length, 'no dated schema-history rows parsed').toBeGreaterThan(3);
    const versions = rows.map((r) => Number(r.split('|')[2]!.trim()));
    expect(versions, `no changelog row documents schema ${SCHEMA_VERSION}`)
      .toContain(SCHEMA_VERSION);
  });
});
