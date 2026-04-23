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

  it('idle sessions are detached server-side after sessionIdleTimeoutMs', async () => {
    // Start a daemon with a very short session timeout.
    const d = await startTestDaemon({ httpExtras: { sessionIdleTimeoutMs: 500 } });
    handles.push(d);
    const { cwd, cleanup } = createTempProject();
    cleanups.push(cleanup);
    const c = await connectTestClient({ url: d.url, cwd });
    // Register a context block, then stop interacting.
    await c.client.callTool({ name: 'register_context_block', arguments: { id: 'idle-test', content: 'x' } });
    // Do NOT call c.close() — simulate a client that went away without terminateSession.
    // Wait past the 500ms timeout so the session becomes stale.
    await new Promise(r => setTimeout(r, 600));
    // Manually trigger eviction (the real timer runs every 60s, which is too slow for tests).
    await d.router.evictIdleSessions(500, {
      onEvict: (sessionId, entry) => {
        d.registry.detachSession(entry.projectContext.cwd, sessionId);
        d.logger.sessionClose({ sessionId, cwd: entry.projectContext.cwd, reason: 'session_expired', durationMs: Date.now() - entry.openedAt });
      },
    });
    // Give onclose a tick to propagate.
    await new Promise(r => setTimeout(r, 100));
    const s = await (await fetch(`${d.url}/status`)).json();
    expect(s.projects.length).toBe(1);
    expect(s.projects[0].activeSessions).toBe(0);  // session was detached
    expect(s.projects[0].contextBlocksSize).toBe(1);  // project state survives
  });

  it('client disconnect + reconnect preserves project state (the bug-fix verification)', async () => {
    // This is the end-to-end verification that the daemon survives a client
    // going away and coming back — the exact failure mode that motivated this
    // feature ("MCP server is down" after Claude Code's /clear or compaction).
    const d = await startTestDaemon();
    handles.push(d);
    const { cwd, cleanup } = createTempProject();
    cleanups.push(cleanup);

    // First session: register a context block, then disconnect.
    const c1 = await connectTestClient({ url: d.url, cwd });
    const reg = await c1.client.callTool({
      name: 'register_context_block',
      arguments: { id: 'survives-reconnect', content: 'from session 1' },
    });
    expect(JSON.parse((reg.content as any[])[0].text).contextBlockId).toBe('survives-reconnect');

    // Pre-disconnect: /status shows the project with 1 block and 1 session.
    {
      const s = await (await fetch(`${d.url}/status`)).json();
      expect(s.projects.length).toBe(1);
      expect(s.projects[0].activeSessions).toBe(1);
      expect(s.projects[0].contextBlocksSize).toBe(1);
    }

    // Client disconnects (simulates Claude Code /clear, compaction, or session exit).
    await c1.close();
    // Poll for up to 2s waiting for the server to notice the disconnect.
    // The SDK's close() sends an explicit DELETE; the server's transport.onclose fires on that.
    let activeSessionsAfterClose: number | undefined;
    for (let i = 0; i < 20; i++) {
      const s = await (await fetch(`${d.url}/status`)).json();
      activeSessionsAfterClose = s.projects[0]?.activeSessions;
      if (activeSessionsAfterClose === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Post-disconnect: project survives with 0 active sessions, block still there.
    {
      const s = await (await fetch(`${d.url}/status`)).json();
      expect(s.projects.length).toBe(1);
      expect(s.projects[0].activeSessions).toBe(0);
      expect(s.projects[0].contextBlocksSize).toBe(1); // STATE PRESERVED — the whole point
    }

    // Reconnect: brand new MCP session, but same ProjectContext on the server.
    const c2 = await connectTestClient({ url: d.url, cwd });
    closers.push(c2.close);

    // Reconnected session can list tools (proves the new session is functional).
    const tools = await c2.client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    // /status confirms the project has a new active session AND still has the block.
    const s = await (await fetch(`${d.url}/status`)).json();
    expect(s.projects.length).toBe(1);
    expect(s.projects[0].activeSessions).toBe(1);
    expect(s.projects[0].contextBlocksSize).toBe(1);
  });
});
