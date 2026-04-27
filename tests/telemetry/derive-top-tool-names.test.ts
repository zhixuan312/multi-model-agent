import { describe, it, expect } from 'vitest';
import { deriveTopToolNames } from '../../packages/core/src/telemetry/event-builder.js';

describe('deriveTopToolNames — permissive', () => {
  it('passes real MCP tool names through unchanged', () => {
    const calls = ['mcp__github__create_issue', 'mcp__github__create_issue', 'web_search'];
    const result = deriveTopToolNames(calls);
    expect(result).toContain('mcp__github__create_issue');
    expect(result).toContain('web_search');
  });

  it('selects up to 20 distinct tool names by frequency', () => {
    const calls: string[] = [];
    for (let i = 0; i < 30; i++) calls.push(`tool-${i}`, `tool-${i}`); // 30 distinct, each twice
    const result = deriveTopToolNames(calls);
    expect(result).toHaveLength(20);
  });

  it("drops tool names that violate BoundedIdentifier shape", () => {
    const calls = ['readFile', 'tool with spaces', 'mcp__github__create_issue'];
    const result = deriveTopToolNames(calls);
    expect(result).toContain('readFile');
    expect(result).toContain('mcp__github__create_issue');
    expect(result.find(t => t.includes(' '))).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(deriveTopToolNames([])).toEqual([]);
  });

  it("does NOT collapse unknown names to 'other' (the old behavior)", () => {
    const calls = ['unknownTool1', 'unknownTool2', 'unknownTool1'];
    const result = deriveTopToolNames(calls);
    expect(result).not.toContain('other');
    expect(result).toContain('unknownTool1');
    expect(result).toContain('unknownTool2');
  });
});
