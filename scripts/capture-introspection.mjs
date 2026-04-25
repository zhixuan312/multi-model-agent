import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot } from '../tests/contract/fixtures/harness.ts';
import { mockProvider } from '../tests/contract/fixtures/mock-providers.ts';
import { normalize } from '../tests/contract/serializer/index.ts';

const root = resolve('tests/contract/goldens');
mkdirSync(resolve(root, 'introspection'), { recursive: true });
mkdirSync(resolve(root, 'errors'), { recursive: true });

async function main() {
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  try {
    const health = await fetch(`${h.baseUrl}/health`);
    writeFileSync(resolve(root, 'introspection/health.json'), JSON.stringify(normalize(await health.json()), null, 2) + '\n');

    const status = await fetch(`${h.baseUrl}/status`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    writeFileSync(resolve(root, 'introspection/status.json'), JSON.stringify(normalize(await status.json()), null, 2) + '\n');

    const unauthorized = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
    });
    writeFileSync(resolve(root, 'errors/unauthorized.json'), JSON.stringify(normalize(await unauthorized.json()), null, 2) + '\n');

    const invalidRequest = await fetch(`${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    writeFileSync(resolve(root, 'errors/invalid-request.json'), JSON.stringify(normalize(await invalidRequest.json()), null, 2) + '\n');

    const notFound = await fetch(`${h.baseUrl}/definitely-not-a-route`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    writeFileSync(resolve(root, 'errors/not-found.json'), JSON.stringify(normalize(await notFound.json()), null, 2) + '\n');
  } finally {
    await h.close();
  }
}

await main();
