/**
 * The user-facing client tables must say what the capability registry actually
 * does.
 *
 * These tables are the first thing a user reads, and a row that names a config
 * path for a client MMA cannot write is worse than no row: it promises an
 * install that refuses. VS Code was listed with "user-level MCP config" while
 * having no writer at all. Deriving the expectation from the registry means the
 * next blocked-or-unblocked client updates the docs or fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { writerForClient } from '../../../packages/server/src/provisioning/registration-writer.js';

const DOCS = ['README.md', 'packages/server/README.md'] as const;

/** Display name each table uses for a capability row. */
const ROW_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  vscode: 'VS Code',
  opencode: 'opencode',
  windsurf: 'Windsurf',
};

function tableRows(markdown: string, label: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith(`| ${label} |`) || line.startsWith(`| **${label}** |`));
}

describe('contract: the client tables match the capability registry', () => {
  it.each(DOCS)('%s lists every canonical client', (doc) => {
    const markdown = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
    for (const capability of CLIENT_CAPABILITIES) {
      const label = ROW_LABEL[capability.id]!;
      expect(tableRows(markdown, label).length, `${doc} has no table row for ${label}`).toBeGreaterThan(0);
    }
  });

  it.each(DOCS)('%s never advertises a registration for a client with no writer', (doc) => {
    const markdown = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
    for (const capability of CLIENT_CAPABILITIES) {
      if (writerForClient(capability.id)) continue;
      for (const row of tableRows(markdown, ROW_LABEL[capability.id]!)) {
        // No config-path-looking cell, and no bare ✅ in the MCP column: the row
        // must visibly say MMA writes nothing for this client.
        expect(row, `${doc}: ${ROW_LABEL[capability.id]} has no writer but its row names a config path`)
          .not.toMatch(/\.json|\.toml|mcp_config|user-level MCP config/);
        expect(row.split('|').slice(-2)[0]?.trim(), `${doc}: ${ROW_LABEL[capability.id]} has no writer but its row claims MCP support`)
          .not.toBe('✅');
      }
    }
  });

  it.each(DOCS)('%s names the real skill root for every client that has one', (doc) => {
    const markdown = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
    for (const capability of CLIENT_CAPABILITIES) {
      if (!capability.skillRoot) continue;
      const rows = tableRows(markdown, ROW_LABEL[capability.id]!);
      expect(
        rows.some((row) => row.includes(capability.skillRoot!)) || rows.some((row) => row.includes('✅')),
        `${doc}: ${ROW_LABEL[capability.id]} must show its skill root ${capability.skillRoot} or a support tick`,
      ).toBe(true);
    }
  });
});
