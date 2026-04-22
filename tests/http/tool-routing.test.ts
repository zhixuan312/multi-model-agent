import { describe, it, expect, afterEach } from 'vitest';
import { startTestDaemon } from '../helpers/mmagent-test-daemon.js';
import { connectTestClient } from '../helpers/http-test-client.js';
import { createTempProject } from '../helpers/temp-project.js';

describe('HTTP tool routing end-to-end', () => {
  let handles: Array<{ stop: () => Promise<void> }> = [];
  let closers: Array<() => Promise<void>> = [];
  let cleanups: Array<() => void> = [];
  afterEach(async () => {
    await Promise.all(closers.map(c => c()));
    closers = [];
    await Promise.all(handles.map(h => h.stop()));
    handles = [];
    for (const c of cleanups) c();
    cleanups = [];
  });

  it('lists tools after initialize', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const { cwd, cleanup } = createTempProject();
    cleanups.push(cleanup);
    const { client, close } = await connectTestClient({ url: d.url, cwd });
    closers.push(close);
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name).sort();
    expect(names).toContain('delegate_tasks');
    expect(names).toContain('register_context_block');
    expect(names.length).toBeGreaterThan(3);
  });

  it('register_context_block returns a uuid id', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const { cwd, cleanup } = createTempProject();
    cleanups.push(cleanup);
    const { client, close } = await connectTestClient({ url: d.url, cwd });
    closers.push(close);
    const reg = await client.callTool({ name: 'register_context_block', arguments: { content: 'hello world' } });
    const regText = (reg.content as any[])[0].text as string;
    const parsed = JSON.parse(regText);
    expect(parsed.contextBlockId).toMatch(/[0-9a-f-]{36}/);
  });

  it('two sessions to different projects have isolated context blocks', async () => {
    const d = await startTestDaemon();
    handles.push(d);
    const p1 = createTempProject();
    const p2 = createTempProject();
    cleanups.push(p1.cleanup, p2.cleanup);
    const c1 = await connectTestClient({ url: d.url, cwd: p1.cwd });
    const c2 = await connectTestClient({ url: d.url, cwd: p2.cwd });
    closers.push(c1.close, c2.close);

    // Register a block on project 1 with a known id.
    const reg = await c1.client.callTool({
      name: 'register_context_block',
      arguments: { id: 'shared-id', content: 'from p1' },
    });
    const { contextBlockId } = JSON.parse((reg.content as any[])[0].text);
    expect(contextBlockId).toBe('shared-id');

    // Register the same id in project 2 with different content.
    // Each project has its own context block store, so the stores are independent.
    const reg2 = await c2.client.callTool({
      name: 'register_context_block',
      arguments: { id: 'shared-id', content: 'from p2' },
    });
    const p2Id = JSON.parse((reg2.content as any[])[0].text).contextBlockId;
    expect(p2Id).toBe('shared-id');

    // Verify via /status that both projects have exactly 1 context block each.
    const statusRes = await fetch(`${d.url}/status`);
    const status = await statusRes.json();
    expect(status.projects.length).toBe(2);
    for (const proj of status.projects) {
      expect(proj.contextBlocksSize).toBe(1);
    }
  });
});
