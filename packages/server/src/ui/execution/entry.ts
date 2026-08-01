import { App } from '@modelcontextprotocol/ext-apps';

/**
 * Bootstrap skeleton for the execution-monitor MCP App.
 *
 * Full polling/cancel state-machine logic lands in a later task
 * (display-state derivation + wiring); this module only establishes the
 * connection seam and the initial mount so the build/bootstrap contract is
 * provable independently of that behavior.
 *
 * `window.__MMA_CREATE_APP__` is a test-only injection seam: when a host
 * page (or a test harness) sets it, the bootstrap uses whatever it returns
 * instead of constructing the real `App`. Production Claude Desktop never
 * sets this, so the fallback below — the vanilla `App` from
 * `@modelcontextprotocol/ext-apps`'s `'.'` export — is the real path a real
 * host exercises.
 */

interface AppLike {
  connect(): Promise<void>;
  ontoolresult: ((params: unknown) => void) | undefined;
  callServerTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

declare global {
  interface Window {
    __MMA_CREATE_APP__?: () => AppLike;
  }
}

function createApp(): AppLike {
  if (typeof window !== 'undefined' && window.__MMA_CREATE_APP__) {
    return window.__MMA_CREATE_APP__();
  }
  return new App({ name: 'mma-execution-monitor', version: '1.0.0' }, {}) as unknown as AppLike;
}

function mount(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('execution App bootstrap: missing #app mount point');
  }
  return root;
}

async function bootstrap(): Promise<void> {
  const root = mount();
  root.textContent = 'connecting…';

  const app = createApp();

  try {
    await app.connect();
  } catch {
    root.textContent = 'connection error';
    return;
  }

  root.textContent = 'connected';
}

void bootstrap();
