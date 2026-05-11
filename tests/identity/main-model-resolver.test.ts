import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMainModel } from '../../packages/core/src/identity/main-model-resolver.js';

describe('resolveMainModel', () => {
  it('returns header value when present (highest priority)', () => {
    const r = resolveMainModel({ headerValue: 'gpt-5.5', client: 'claude-code', cwd: '/tmp', configDefaultMainModel: 'fallback', homeDir: '/nonexistent' });
    expect(r.model).toBe('gpt-5.5');
    expect(r.source).toBe('header');
  });

  it('claude-code: reads model from latest jsonl', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-resolver-home-'));
    const projectsDir = join(home, '.claude', 'projects', '-tmp-myapp');
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'a1.jsonl'),
      JSON.stringify({ type: 'message', model: 'claude-opus-4-7' }) + '\n'
    );
    try {
      const r = resolveMainModel({ headerValue: undefined, client: 'claude-code', cwd: '/tmp/myapp', configDefaultMainModel: undefined, homeDir: home });
      expect(r.model).toBe('claude-opus-4-7');
      expect(r.source).toBe('auto:claude-code');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('codex-cli: reads top-level model from ~/.codex/config.toml', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-resolver-home-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');
    try {
      const r = resolveMainModel({ headerValue: undefined, client: 'codex-cli', cwd: '/tmp/myapp', configDefaultMainModel: undefined, homeDir: home });
      expect(r.model).toBe('gpt-5.5');
      expect(r.source).toBe('auto:codex-cli');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls through to config when client state is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-resolver-home-'));
    try {
      const r = resolveMainModel({ headerValue: undefined, client: 'claude-code', cwd: '/tmp/myapp', configDefaultMainModel: 'claude-sonnet-4-6', homeDir: home });
      expect(r.model).toBe('claude-sonnet-4-6');
      expect(r.source).toBe('config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns sentinel when nothing resolves', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-resolver-home-'));
    try {
      const r = resolveMainModel({ headerValue: undefined, client: 'cursor', cwd: '/tmp/myapp', configDefaultMainModel: undefined, homeDir: home });
      expect(r.model).toBe('unknown_main_model');
      expect(r.source).toBe('unknown');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('claude-code: jsonl without model field falls through to config', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-resolver-home-'));
    const projectsDir = join(home, '.claude', 'projects', '-tmp-myapp');
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'a1.jsonl'), JSON.stringify({ type: 'message' }) + '\n');
    try {
      const r = resolveMainModel({ headerValue: undefined, client: 'claude-code', cwd: '/tmp/myapp', configDefaultMainModel: 'fallback-model', homeDir: home });
      expect(r.model).toBe('fallback-model');
      expect(r.source).toBe('config');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
