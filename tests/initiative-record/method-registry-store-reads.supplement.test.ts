/**
 * SPEC-005 Method Registry store reads — supplementary edge-case coverage (Task I-2).
 *
 * `method-guidance-assets.test.ts` and `method-registry-contract-and-migration.test.ts` are the
 * plan-authored acceptance tests and are never edited. Neither directly exercises
 * `InitiativeRecordStore.getMethod()`, its `unknown_method` error path, or the
 * malformed-stored-JSON / non-conforming-declaration `invalid_request` paths the Contract names
 * ("An unknown stored identifier throws `UnknownMethodError`. Invalid stored JSON or a
 * declaration that fails the strict schema throws `invalid_request` rather than returning a
 * partial definition."). This file covers those gaps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';
import { resolveGuidanceFromRootForTest } from '../../packages/core/src/initiative-record/method-guidance.js';

function withStore(run: (store: InitiativeRecordStore, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mma-method-store-reads-'));
  const dbPath = join(dir, 'initiatives.db');
  const store = InitiativeRecordStore.open({ dbPath });
  try {
    run(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('Method registry store reads — supplementary edge cases', () => {
  it('rejects an orphan guidance asset rather than resolving a partial production catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'mma-method-guidance-orphan-'));
    try {
      for (const id of [
        'architecture-review@1',
        'intent-to-initiative@1',
        'regulatory-assessment@1',
        'research@1',
        'risk-analysis@1',
        'software-change@1',
        'solution-design@1',
        'source-validation@1',
        'technical-writing@1',
        'workflow-design@1',
        'orphan@1',
      ]) {
        const directory = join(root, id.split('@')[0]!);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'guidance.md'), `# ${id}\n`);
      }

      expect(() => resolveGuidanceFromRootForTest('software-change@1', root)).toThrow(/orphan|guidance/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('getMethod returns the exact registered declaration for a known identifier', () => {
    withStore((store) => {
      const method = store.getMethod({ id: 'software-change@1' });
      expect(method).toEqual({
        id: 'software-change@1',
        name: 'Software change',
        version: 1,
        purpose: 'Change software safely to satisfy a defined need.',
        required_inputs: ['source code', 'requested behavior', 'acceptance criteria'],
        expected_outputs: ['changed source code', 'test evidence'],
        verification_expectations: [
          'caller tracing',
          'error-path review',
          'security-sink review',
          'schema conformance',
          'test adequacy',
        ],
      });
    });
  });

  it('getMethod throws unknown_method for an unregistered but well-formed identifier', () => {
    withStore((store) => {
      expect(thrownCode(() => store.getMethod({ id: 'missing@1' }))).toBe('unknown_method');
    });
  });

  it('getMethod throws invalid_request rather than a partial definition for malformed stored JSON', () => {
    withStore((store, dbPath) => {
      store.close();
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE methods SET definition_json = ? WHERE id = ?`).run('{not json', 'software-change@1');
      raw.close();
      const reopened = InitiativeRecordStore.open({ dbPath });
      try {
        expect(thrownCode(() => reopened.getMethod({ id: 'software-change@1' }))).toBe('invalid_request');
        expect(thrownCode(() => reopened.listMethods())).toBe('invalid_request');
      } finally {
        reopened.close();
      }
    });
  });

  it('getMethod throws invalid_request rather than a partial definition for a declaration that fails the strict schema', () => {
    withStore((store, dbPath) => {
      store.close();
      const raw = new DatabaseSync(dbPath);
      // Well-formed JSON, but violates `methodDeclarationSchema`'s `.strict()` — an unknown key.
      raw.prepare(`UPDATE methods SET definition_json = ? WHERE id = ?`).run(
        JSON.stringify({
          id: 'software-change@1',
          name: 'Software change',
          version: 1,
          purpose: 'Change software safely to satisfy a defined need.',
          required_inputs: [],
          expected_outputs: [],
          verification_expectations: [],
          unexpected_extra_field: 'should be rejected',
        }),
        'software-change@1',
      );
      raw.close();
      const reopened = InitiativeRecordStore.open({ dbPath });
      try {
        expect(thrownCode(() => reopened.getMethod({ id: 'software-change@1' }))).toBe('invalid_request');
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects a declaration whose JSON identifier differs from its stored row identifier', () => {
    withStore((store, dbPath) => {
      store.close();
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE methods SET definition_json = ? WHERE id = ?`).run(
        JSON.stringify({
          id: 'research@1',
          name: 'Research',
          version: 1,
          purpose: 'Produce an evidence-based answer to a focused question.',
          required_inputs: ['research question', 'source constraints'],
          expected_outputs: ['findings', 'sources', 'limitations'],
          verification_expectations: ['source relevance', 'claim support', 'limitation disclosure'],
        }),
        'software-change@1',
      );
      raw.close();
      const reopened = InitiativeRecordStore.open({ dbPath });
      try {
        expect(thrownCode(() => reopened.getMethod({ id: 'software-change@1' }))).toBe('invalid_request');
      } finally {
        reopened.close();
      }
    });
  });

  it('listMethods returns all ten registered declarations in ascending identifier order', () => {
    withStore((store) => {
      const ids = store.listMethods().map((method) => method.id);
      expect(ids).toEqual(
        [
          'architecture-review@1',
          'intent-to-initiative@1',
          'regulatory-assessment@1',
          'research@1',
          'risk-analysis@1',
          'software-change@1',
          'solution-design@1',
          'source-validation@1',
          'technical-writing@1',
          'workflow-design@1',
        ].sort(),
      );
      expect(ids).toEqual([...ids].sort());
    });
  });
});
