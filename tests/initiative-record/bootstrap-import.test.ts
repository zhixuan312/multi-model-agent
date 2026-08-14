import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { main } from '../../packages/server/src/cli/index.js';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';

async function run(argv: string[], cwd: string, homeDir: string) {
  let exitCode = -1; const stderr: string[] = [];
  await main({ argv: () => argv, cwd: () => cwd, homeDir: () => homeDir, stdout: () => true, stderr: (line) => { stderr.push(line); return true; }, exit: ((code: number) => { exitCode = code; throw new Error('exit'); }) as never }).catch((error: unknown) => { if (!(error instanceof Error) || error.message !== 'exit') throw error; });
  return { exitCode, stderr: stderr.join('') };
}

describe('initiatives import-bootstrap', () => {
  it('imports existing artifacts, reports optional misses, and updates one changed ArtifactRef on rerun', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mma-bootstrap-')); const nested = join(root, 'work', 'nested'); const stateDir = join(root, 'state');
    mkdirSync(join(root, '.mma', 'specs'), { recursive: true }); mkdirSync(join(root, '.mma', 'plans'), { recursive: true }); mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.mma', 'specs', 'flow.md'), '---\ntitle: "Bootstrap title"\ngoal: "Bootstrap goal"\n---\n');
    writeFileSync(join(root, '.mma', 'plans', 'flow.md'), 'artifact one');
    writeFileSync(join(root, '.mma', 'config.json'), JSON.stringify({ server: { stateDir, bind: '127.0.0.1', port: 0, auth: { tokenFile: join(root, 'token') }, limits: { maxBodyBytes: 1, batchTtlMs: 1, projectCap: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 }, autoUpdateSkills: false } })); // <home>/.mma/config.json is a searched candidate path (homeDir = root); <root>/.mma.json would never be found with cwd = nested
    try {
      const first = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], nested, root);
      expect(first.exitCode).toBe(0); expect(first.stderr).toContain(`missing artifact: ${join(root, '.mma', 'explorations', 'flow.md')}`);
      writeFileSync(join(root, '.mma', 'plans', 'flow.md'), 'artifact two');
      const second = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], nested, root);
      expect(second.exitCode).toBe(0);
      const store = InitiativeRecordStore.open({ dbPath: join(stateDir, 'initiatives.db') });
      try { const init = store.getInitiative({ human_key: 'MMA-INIT-001' })!; expect(init.title).toBe('Bootstrap title'); expect(store.listInitiativeArtifacts(init.uuid)).toHaveLength(2); expect(store.listEvents({ initiative_id: init.uuid }).filter((event) => event.event_type === 'artifact_updated')).toHaveLength(1); } finally { store.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses the pinned no-workspace, metadata, and precondition failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mma-bootstrap-errors-'));
    try {
      const noWorkspace = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], root, root);
      expect(noWorkspace.exitCode).toBe(1);
      expect(noWorkspace.stderr).toBe(`no .mma workspace found from: ${root}\n`);
      mkdirSync(join(root, '.mma', 'specs'), { recursive: true });
      const absent = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], root, root);
      expect(absent.exitCode).toBe(1);
      expect(absent.stderr).toBe(`bootstrap metadata error: ${join(root, '.mma', 'specs', 'flow.md')} missing title or goal frontmatter\n`);
      writeFileSync(join(root, '.mma', 'specs', 'flow.md'), '---\ntitle: ""\n---\n');
      const metadata = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], root, root);
      expect(metadata.exitCode).toBe(1); expect(metadata.stderr).toBe(`bootstrap metadata error: ${join(root, '.mma', 'specs', 'flow.md')} missing title or goal frontmatter\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails the pinned precondition with zero writes when Initiatives exist but MMA-INIT-001 does not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mma-bootstrap-precondition-')); const stateDir = join(root, 'state');
    mkdirSync(join(root, '.mma', 'specs'), { recursive: true });
    writeFileSync(join(root, '.mma', 'specs', 'flow.md'), '---\ntitle: "T"\ngoal: "G"\n---\n');
    writeFileSync(join(root, '.mma', 'config.json'), JSON.stringify({ server: { stateDir, bind: '127.0.0.1', port: 0, auth: { tokenFile: join(root, 'token') }, limits: { maxBodyBytes: 1, batchTtlMs: 1, projectCap: 1, maxContextBlockBytes: 1, maxContextBlocksPerProject: 1, shutdownDrainMs: 1 }, autoUpdateSkills: false } }));
    const provenance = { actor_type: 'system', actor_id: 's', interface: 'cli', initiated_by: 's', authorized_by: 'h', timestamp: '2026-08-12T00:00:00.000Z', source: 'manual' } as const;
    const seed = InitiativeRecordStore.open({ dbPath: join(stateDir, 'initiatives.db') });
    const product = seed.execute({ operation: 'product_create', input: { name: 'Other', slug: 'other' }, expected_revision: 0, provenance });
    seed.execute({ operation: 'initiative_create', input: { product_id: product.uuid, title: 'X', goal: 'g', status: 'open', outcome: null }, expected_revision: 0, provenance });
    const eventsBefore = seed.listEvents({}).length; seed.close();
    // Manufacture the unreachable-by-API precondition state with raw SQL (the monotonic
    // allocator always yields MMA-INIT-001 first, so no public operation can produce it):
    const raw = new DatabaseSync(join(stateDir, 'initiatives.db'));
    raw.exec("UPDATE initiatives SET human_key = 'MMA-INIT-099'");
    raw.close();
    try {
      const blocked = await run(['initiatives', 'import-bootstrap', '--stem', 'flow'], root, root);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr).toBe('bootstrap precondition failed: initiative table is not empty and MMA-INIT-001 does not exist\n');
      const check = InitiativeRecordStore.open({ dbPath: join(stateDir, 'initiatives.db') });
      try { expect(check.listEvents({})).toHaveLength(eventsBefore); expect(() => check.getInitiative({ human_key: 'MMA-INIT-001' })).toThrow(/not_found/); } finally { check.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});