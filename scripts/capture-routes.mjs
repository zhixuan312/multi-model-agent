import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../packages/server/dist/http/server.js';

process.env.MMAGENT_TEST_INTROSPECTION = '1';
process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';

const token = randomUUID();
const tokenPath = join(tmpdir(), `mmagent-test-token-${randomUUID()}`);
writeFileSync(tokenPath, `${token}\n`, 'utf8');

const config = {
  agents: {
    standard: {
      type: 'openai-compatible',
      baseUrl: 'http://mock.local',
      apiKey: 'stub',
      model: 'mock',
    },
    complex: {
      type: 'openai-compatible',
      baseUrl: 'http://mock.local',
      apiKey: 'stub',
      model: 'mock',
    },
  },
  defaults: {
    timeoutMs: 1_800_000,
    maxCostUSD: 10,
    tools: 'full',
    sandboxPolicy: 'cwd-only',
  },
  server: {
    bind: '127.0.0.1',
    port: 0,
    auth: { tokenFile: tokenPath },
    limits: {
      maxBodyBytes: 10_485_760,
      batchTtlMs: 3_600_000,
      idleProjectTimeoutMs: 1_800_000,
      clarificationTimeoutMs: 86_400_000,
      projectCap: 200,
      maxBatchCacheSize: 500,
      maxContextBlockBytes: 524_288,
      maxContextBlocksPerProject: 32,
      shutdownDrainMs: 30_000,
    },
    autoUpdateSkills: false,
  },
};

const server = await startServer(config);
try {
  const res = await fetch(`http://127.0.0.1:${server.port}/__routes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`route capture failed: ${res.status} ${await res.text()}`);
  }
  const routes = await res.json();
  const normalized = routes
    .map((route) => `${String(route.method).toUpperCase()} ${String(route.path)}`)
    .sort();
  writeFileSync(resolve('tests/contract/goldens/routes.json'), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
} finally {
  await server.stop();
  await unlink(tokenPath).catch(() => undefined);
}
