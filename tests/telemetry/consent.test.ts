import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import type { FSWatcher } from 'node:fs';
import { decide, watchConfigForChanges } from '../../packages/server/src/telemetry/consent';

// NOTE: fs is injected into the SUT (decide/watchConfigForChanges accept
// readFile/watch params). We deliberately do NOT use `vi.mock('node:fs')` —
// under Bun `mock.module` is process-global and sticky (it does not restore
// after this file), which previously leaked a mocked readFileSync into every
// later test that reads real files (skill-frontmatter, install, cli, …).

const homeDir = '/tmp/mma-test-home';

describe('consent', () => {
  let originalEnv: string | undefined;
  let readFileSyncMock: ReturnType<typeof vi.fn>;
  let watchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = process.env.MMAGENT_TELEMETRY;
    delete process.env.MMAGENT_TELEMETRY;
    readFileSyncMock = vi.fn();
    watchMock = vi.fn();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MMAGENT_TELEMETRY;
    } else {
      process.env.MMAGENT_TELEMETRY = originalEnv;
    }
  });

  // -- decide() -------------------------------------------------------

  it('env=1 → enabled:true, source:env', () => {
    process.env.MMAGENT_TELEMETRY = '1';
    readFileSyncMock.mockReturnValue('{}');

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: true, source: 'env' });
  });

  it('env absent + config.telemetry.enabled=true → enabled:true, source:config', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: true, source: 'config' });
  });

  it('env absent + config absent (ENOENT) → enabled:false, source:default', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileSyncMock.mockImplementation(() => { throw err; });

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: false, source: 'default' });
  });

  it('accepts bare top-level enabled shape as fallback', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ enabled: true }));

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: true, source: 'config' });
  });

  it('prefers telemetry.enabled when both shapes present', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({
      enabled: false,
      telemetry: { enabled: true },
    }));

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: true, source: 'config' });
  });

  it('config parse failure → enabled:false, source:config_unreadable', () => {
    readFileSyncMock.mockReturnValue('not-json{{{');

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: false, source: 'config_unreadable' });
  });

  it('env=invalidTypo → enabled:false, source:env_invalid (blocks config)', () => {
    process.env.MMAGENT_TELEMETRY = 'invalidTypo';
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: false, source: 'env_invalid' });
  });

  it('env="" + config.telemetry.enabled=true → config wins', () => {
    process.env.MMAGENT_TELEMETRY = '';
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    expect(decide(homeDir, readFileSyncMock as never)).toEqual({ enabled: true, source: 'config' });
  });

  // -- watchConfigForChanges() ----------------------------------------

  it('watcher fires onChange() when config.json is changed', () => {
    vi.useFakeTimers({ now: 0 });

    const onChange = vi.fn();

    const w = { close: vi.fn() } as unknown as FSWatcher;
    watchMock.mockReturnValue(w);

    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    readFileSyncMock.mockImplementation(() => { throw err; });

    const cleanup = watchConfigForChanges(homeDir, onChange, watchMock as never, readFileSyncMock as never);

    // fs.watch(filename, options, listener) — listener is third arg
    expect(watchMock).toHaveBeenCalledTimes(1);
    const listener = watchMock.mock.calls[0][2] as (event: string, filename: string) => void;

    listener('change', 'config.json');

    // Before debounce timeout, onChange should NOT have been called
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ enabled: false, source: 'default' });

    cleanup();
    vi.useRealTimers();
  });

  it('watcher ignores non-config.json file changes', () => {
    const onChange = vi.fn();

    const w = { close: vi.fn() } as unknown as FSWatcher;
    watchMock.mockReturnValue(w);

    const cleanup = watchConfigForChanges(homeDir, onChange, watchMock as never, readFileSyncMock as never);

    const listener = watchMock.mock.calls[0][2] as (event: string, filename: string) => void;
    listener('change', 'other-file.json');
    listener('change', 'config.json.bak');
    listener('change', undefined as any);

    expect(onChange).not.toHaveBeenCalled();

    cleanup();
  });

  it('watcher debounces rapid write+rename sequences (500ms)', () => {
    vi.useFakeTimers({ now: 0 });

    const onChange = vi.fn();

    const w = { close: vi.fn() } as unknown as FSWatcher;
    watchMock.mockReturnValue(w);
    readFileSyncMock.mockReturnValue(JSON.stringify({ telemetry: { enabled: true } }));

    const cleanup = watchConfigForChanges(homeDir, onChange, watchMock as never, readFileSyncMock as never);
    const listener = watchMock.mock.calls[0][2] as (event: string, filename: string) => void;

    listener('change', 'config.json');
    vi.advanceTimersByTime(200);
    listener('change', 'config.json'); // resets debounce
    vi.advanceTimersByTime(200);
    listener('change', 'config.json'); // resets debounce again

    vi.advanceTimersByTime(200);
    expect(onChange).not.toHaveBeenCalled();

    // Complete the debounce
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);

    cleanup();
    vi.useRealTimers();
  });

  it('watchConfigForChanges cleanup closes watcher and clears timer', () => {
    vi.useFakeTimers({ now: 0 });

    const onChange = vi.fn();
    const w = { close: vi.fn() } as unknown as FSWatcher;
    watchMock.mockReturnValue(w);

    const cleanup = watchConfigForChanges(homeDir, onChange, watchMock as never, readFileSyncMock as never);
    const listener = watchMock.mock.calls[0][2] as (event: string, filename: string) => void;
    listener('change', 'config.json');

    cleanup();

    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(w.close).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
