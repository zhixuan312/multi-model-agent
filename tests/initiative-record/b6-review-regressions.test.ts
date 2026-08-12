import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InitiativeRecordStore } from '../../packages/core/src/initiative-record/index.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const provenance = {
  actor_type: 'human',
  actor_id: 'u1',
  interface: 'http',
  initiated_by: 'u1',
  authorized_by: 'u1',
  timestamp: '2026-08-12T00:00:00.000Z',
  source: 'manual',
} as const;

describe('B6 review regressions', () => {
  it('a caller-supplied args.operation cannot override the MCP tool-selected operation', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    const client = new Client({ name: 'b6-regression', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${h.token}` } },
      }),
    );
    try {
      // Read-only tool name, but the args smuggle a mutating operation. The
      // tool name must win: the call behaves as product_get, so the missing
      // lookup / unknown product surfaces as an error and no Product exists.
      const smuggled = await client.callTool({
        name: 'mma_product_get',
        arguments: {
          operation: 'product_create',
          input: { name: 'Smuggled', slug: 'smuggled' },
          expected_revision: 0,
          provenance,
        },
      });
      expect(smuggled.isError).toBe(true);
      const list = await client.callTool({ name: 'mma_product_list', arguments: { input: {} } });
      expect(list.isError).toBeFalsy();
      const products = JSON.parse((list.content as Array<{ text: string }>)[0]!.text) as Array<{ slug: string }>;
      expect(products.some((product) => product.slug === 'smuggled')).toBe(false);

      // Advertised mutation schemas never declare the adapter-stamped
      // provenance fields as caller-required.
      const tools = (await client.listTools()).tools;
      const createTool = tools.find((tool) => tool.name === 'mma_product_create');
      expect(createTool).toBeDefined();
      const provSchema = (createTool!.inputSchema as { properties?: Record<string, { required?: string[] }> })
        .properties?.provenance;
      expect(provSchema).toBeDefined();
      expect(provSchema!.required ?? []).not.toContain('interface');
      expect(provSchema!.required ?? []).not.toContain('timestamp');
    } finally {
      await client.close();
      await h.close();
    }
  });

  it('an up-to-date database re-opens without creating a backup file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-b6-backup-'));
    const dbPath = join(dir, 'initiatives.db');
    try {
      const first = InitiativeRecordStore.open({ dbPath });
      first.close();
      const second = InitiativeRecordStore.open({ dbPath });
      second.close();
      expect(existsSync(dbPath)).toBe(true);
      const backups = readdirSync(dir).filter((name) => name.includes('.bak-'));
      expect(backups).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a migration backup contains committed rows that were still sitting in the WAL sidecar', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { runInitiativeMigrations } = await import('../../packages/core/src/initiative-record/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'mma-b6-wal-backup-'));
    const dbPath = join(dir, 'initiatives.db');
    // Seed a WAL-mode database at an OLDER schema version whose committed row
    // lives only in the -wal sidecar: the writer connection stays OPEN across
    // the migration run, so its close-time checkpoint never happens first —
    // the same shape as a process that died before closing cleanly.
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec('PRAGMA journal_mode = WAL;');
      writer.exec('CREATE TABLE legacy_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
      writer.exec("INSERT INTO legacy_rows (value) VALUES ('survives-backup');");
      writer.exec('PRAGMA user_version = 0;');
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      const result = runInitiativeMigrations({ dbPath });
      expect(result.backup_path).toBeDefined();
      const backup = new DatabaseSync(result.backup_path!);
      try {
        const row = backup
          .prepare('SELECT value FROM legacy_rows WHERE value = ?')
          .get('survives-backup') as { value: string } | undefined;
        expect(row?.value).toBe('survives-backup');
      } finally {
        backup.close();
      }
    } finally {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an idempotency replay under a different caller identity is rejected, not silently attributed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-b6-idempotency-'));
    const store = InitiativeRecordStore.open({ dbPath: join(dir, 'initiatives.db') });
    try {
      const request = {
        operation: 'product_create' as const,
        input: { name: 'MMA', slug: 'mma' },
        expected_revision: 0,
        idempotency_key: 'bootstrap-product',
        provenance,
      };
      const first = store.execute(request);
      // Same everything, adapter-stamped fields differ: still a replay.
      const replay = store.execute({
        ...request,
        provenance: { ...provenance, interface: 'mcp', timestamp: '2026-08-12T09:09:09.000Z' },
      });
      expect(replay).toEqual(first);
      expect(store.listEvents({})).toHaveLength(1);
      // Different caller-owned identity: rejected, no silent attribution.
      expect(() =>
        store.execute({ ...request, provenance: { ...provenance, actor_id: 'someone-else' } }),
      ).toThrow(/invalid_request/);
      expect(store.listEvents({})).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
