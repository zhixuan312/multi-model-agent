import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { InitiativeRecordStore, registerTargetAdapter } from '../../packages/core/src/initiative-record/index.js';

const MARKER = 'spec007-test-only-fake-adapter';
const provenance = { actor_type: 'agent', actor_id: 'test', interface: 'test', initiated_by: 'test', authorized_by: 'test', timestamp: '2026-08-14T00:00:00.000Z', source: 'test' };
function nonTestSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return nonTestSourceFiles(path);
    return /\.(?:ts|mts|cts)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

// SPEC-007 FR-8's ban is on target-specific BRANCHING and target-specific fields in the
// delivery-validation path, not on the two named inert-declaration exceptions: the seeded
// Delivery Contract catalog (`migrations.ts`, required by FR-2) and the packager registry's
// fixed identifier-to-asset allowlist (`delivery-packagers.ts`), which mirrors the established
// `GUIDANCE_ASSET_IDS` precedent in `method-guidance.ts`. Both are inert data a bijection or seed
// check reads, not core code that behaves differently per target.
//
// A seeded target-type literal (e.g. `runnable-prototype`) can also appear in descriptive text
// or schema messages outside those two files. Parse TypeScript instead of scanning lines, then
// reject only the executable control-flow and lookup forms that make core behave differently by
// target. This catches multiline and aliased-value branches as well as object/Map/Set lookups.
const TARGET_TYPE_LITERALS = ['runnable-prototype', 'runnable-software'];
const ALLOWED_TARGET_LITERAL_FILES = new Set(['initiative-record/delivery-packagers.ts', 'initiative-record/migrations.ts']);

function targetLiteralAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      TARGET_TYPE_LITERALS.includes(node.initializer.text)
    ) aliases.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

function isTargetSpecificControlOrLookup(value: ts.Node): boolean {
  for (let node: ts.Node = value; node.parent; node = node.parent) {
    const parent = node.parent;
    if (
      (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) &&
      value.pos >= parent.condition.pos && value.end <= parent.condition.end
    ) return true;
    if (ts.isCaseClause(parent)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)
    ) return true;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
      const name = ts.isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : undefined;
      if (name === 'get' || name === 'has' || name === 'includes' || name === 'set') return true;
    }
    if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'Map') return true;
  }
  return false;
}

function targetLiteralOccurrences(root: string): { path: string; literal: string; line: string }[] {
  return nonTestSourceFiles(root).flatMap((path) => {
    if (ALLOWED_TARGET_LITERAL_FILES.has(relative(root, path).replaceAll('\\', '/'))) return [];
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const aliases = targetLiteralAliases(source);
    const occurrences: { path: string; literal: string; line: string }[] = [];
    const visit = (node: ts.Node): void => {
      const isTargetLiteral = ts.isStringLiteral(node) && TARGET_TYPE_LITERALS.includes(node.text);
      const isTargetLiteralAlias = ts.isIdentifier(node) && aliases.has(node.text);
      if ((isTargetLiteral || isTargetLiteralAlias) && isTargetSpecificControlOrLookup(node)) {
        occurrences.push({ path, literal: node.getText(source), line: source.text.slice(node.getFullStart(), node.getEnd()).trim() });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return occurrences;
  });
}

describe('SPEC-007 fake adapter capability proof', () => {
  it('detects multiline target-type branching rather than relying on line adjacency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-target-branch-'));
    try {
      writeFileSync(join(dir, 'multiline-branch.ts'), `if (\n  deliverable.target_type ===\n  'runnable-prototype'\n) {\n  validatePrototype();\n}\n`);
      expect(targetLiteralOccurrences(dir)).not.toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('detects a target-type branch through a named target literal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-target-branch-'));
    try {
      writeFileSync(join(dir, 'aliased-branch.ts'), `const PROTOTYPE = 'runnable-prototype';\nif (deliverable.target_type === PROTOTYPE) validatePrototype();\n`);
      expect(targetLiteralOccurrences(dir)).not.toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('changes a complete Deliverable only after public adapter registration and keeps the marker out of core', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-fake-adapter-'));
    try {
      const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
      const product = store.execute({ operation: 'product_create', input: { name: 'P', slug: 'p' }, expected_revision: 0, provenance }) as { uuid: string };
      const initiative = store.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, expected_revision: 0, provenance }) as { uuid: string };
      let revision = 0;
      const deliverable = store.execute({ operation: 'deliverable_define', input: { initiative_id: initiative.uuid, target_type: 'runnable-prototype', delivery_contract: 'runnable-prototype@1' }, expected_revision: revision, provenance }) as { uuid: string; revision: number };
      revision = deliverable.revision;
      for (const requirement of ['executable_prototype', 'sample_data', 'usage_instructions', 'known_limitations', 'acceptance_evidence']) {
        const artifact = store.execute({ operation: 'artifact_register', input: { initiative_id: initiative.uuid, storage_mode: 'managed', path_or_uri: requirement, description: requirement }, expected_revision: 0, provenance }) as { uuid: string };
        store.execute({ operation: 'deliverable_attach_artifact', input: { deliverable_id: deliverable.uuid, artifact_id: artifact.uuid, requirement }, expected_revision: revision, provenance });
        // DeliverableArtifactMember is the membership row and carries no revision by contract,
        // so read the Deliverable's own revision back rather than expecting one on the member.
        revision = store.getDeliverable({ uuid: deliverable.uuid }).revision;
      }
      const baseline = store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: revision, provenance }) as { validation_state: string; revision: number };
      expect(baseline.validation_state).toBe('valid');
      registerTargetAdapter({ target_type: 'runnable-prototype', validate: () => ({ valid: false, detail: MARKER }) });
      const changed = store.execute({ operation: 'deliverable_validate', input: { deliverable_id: deliverable.uuid }, expected_revision: baseline.revision, provenance }) as { validation_state: string };
      expect(changed.validation_state).toBe('invalid');
      const coreRoot = resolve(import.meta.dirname, '../../packages/core/src');
      expect(nonTestSourceFiles(coreRoot).filter((path) => readFileSync(path, 'utf8').includes(MARKER))).toEqual([]);
      // FR-8: no target-specific branching or mapping outside the two named inert-declaration
      // exceptions (the FR-2 seed catalog and the packager asset allowlist).
      expect(targetLiteralOccurrences(coreRoot)).toEqual([]);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
