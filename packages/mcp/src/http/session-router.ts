import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ProjectContext } from '@zhixuan92/multi-model-agent-core';

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  projectContext: ProjectContext;
  openedAt: number;
}

export class SessionRouter {
  private readonly map = new Map<string, SessionEntry>();

  set(sessionId: string, entry: SessionEntry): void {
    this.map.set(sessionId, entry);
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.map.get(sessionId);
  }

  /**
   * Remove the entry from the map without calling transport.close() / server.close().
   * Use this from inside transport.onclose to avoid reentrant close calls.
   */
  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  /**
   * Remove the entry AND dispose its transport + server. Use from external shutdown paths
   * where the transport is still live. Idempotent; safe to call when the entry is already gone.
   */
  async remove(sessionId: string): Promise<void> {
    const entry = this.map.get(sessionId);
    if (!entry) return;
    this.map.delete(sessionId);
    try { await entry.transport.close(); } catch { /* best-effort */ }
    try { await entry.server.close(); } catch { /* best-effort */ }
  }

  async closeAll(): Promise<void> {
    const ids = Array.from(this.map.keys());
    await Promise.all(ids.map(id => this.remove(id)));
  }

  *entries(): IterableIterator<[string, SessionEntry]> {
    yield* this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }
}
