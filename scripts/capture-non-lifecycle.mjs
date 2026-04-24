import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boot } from '../tests/contract/fixtures/harness.ts';
import { mockProvider } from '../tests/contract/fixtures/mock-providers.ts';
import { normalize } from '../tests/contract/serializer/index.ts';

const root = resolve('tests/contract/goldens');
mkdirSync(resolve(root, 'endpoints'), { recursive: true });

async function pollToTerminal(baseUrl, token, batchId) {
  for (let i = 0; i < 120; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) {
      return await poll.json();
    }
    if (poll.status !== 202) {
      throw new Error(`Unexpected status ${poll.status} during poll for batch ${batchId}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout for batch ${batchId}`);
}

async function main() {
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  try {
    // 1. POST /context-blocks — valid body → 200
    const validCtx = await fetch(
      `${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ content: 'hello from context block' }),
      },
    );
    writeFileSync(
      resolve(root, 'endpoints/register-context-block-ok.json'),
      JSON.stringify(normalize(await validCtx.json()), null, 2) + '\n',
    );

    // 2. POST /context-blocks — empty body → 400
    const invalidCtx = await fetch(
      `${h.baseUrl}/context-blocks?cwd=${encodeURIComponent(process.cwd())}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({}),
      },
    );
    writeFileSync(
      resolve(root, 'endpoints/register-context-block-invalid.json'),
      JSON.stringify(normalize(await invalidCtx.json()), null, 2) + '\n',
    );

    // 3. GET /batch/:id?taskIndex=N — taskIndex=0 on 2-task batch → 200
    const dispatch2 = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${h.token}`,
      },
      body: JSON.stringify({ tasks: [{ prompt: 'task one' }, { prompt: 'task two' }] }),
    });
    const dispatch2Data = await dispatch2.json();
    const batchId = dispatch2Data.batchId;
    await pollToTerminal(h.baseUrl, h.token, batchId);

    const slice = await fetch(`${h.baseUrl}/batch/${batchId}?taskIndex=0`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    writeFileSync(
      resolve(root, 'endpoints/get-batch-slice-ok.json'),
      JSON.stringify(normalize(await slice.json()), null, 2) + '\n',
    );

    // 4. GET /batch/:id?taskIndex=N — out-of-range → 404
    const sliceOutOfRange = await fetch(`${h.baseUrl}/batch/${batchId}?taskIndex=5`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    writeFileSync(
      resolve(root, 'endpoints/get-batch-slice-out-of-range.json'),
      JSON.stringify(normalize(await sliceOutOfRange.json()), null, 2) + '\n',
    );

    // 5. POST /retry — incomplete task retried → 202, then poll to terminal
    const h2 = await boot({ provider: mockProvider({ stage: 'incomplete' }), cwd: process.cwd() });
    try {
      const dispatchRetry = await fetch(`${h2.baseUrl}/delegate?cwd=${process.cwd()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h2.token}`,
        },
        body: JSON.stringify({ tasks: [{ prompt: 'hello' }] }),
      });
      const retryDispatchData = await dispatchRetry.json();
      const dispatchBatchId = retryDispatchData.batchId;
      const dispatchTerminal = await pollToTerminal(h2.baseUrl, h2.token, dispatchBatchId);
      // batchCache-level batchId lives in terminal payload — retry operates on this one
      const cacheBatchId = dispatchTerminal.batchId;

      const retryRes = await fetch(`${h2.baseUrl}/retry?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${h2.token}`,
        },
        body: JSON.stringify({ batchId: cacheBatchId, taskIndices: [0] }),
      });
      const retryResData = await retryRes.json();
      const newBatchId = retryResData.batchId;
      const terminal = await pollToTerminal(h2.baseUrl, h2.token, newBatchId);
      writeFileSync(
        resolve(root, 'endpoints/retry-tasks-ok.json'),
        JSON.stringify(normalize(terminal), null, 2) + '\n',
      );
    } finally {
      await h2.close();
    }
  } finally {
    await h.close();
  }
}

await main();