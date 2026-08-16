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
import { writerForClient } from '../../../packages/server/src/provisioning/writers/registry.js';

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

  /**
   * The path table must name the REAL root — not merely tick a box somewhere.
   *
   * This read `rows.some(includes(skillRoot)) || rows.some(includes('✅'))`. Each client with
   * skills support has a row in the tick table too, so the second branch always fired and the
   * first was dead: the README could advertise `~/.wrong/path/` for Cursor and this passed.
   * Verified by doing exactly that.
   *
   * The disjunction was there because the two tables have different shapes — one names paths,
   * one ticks support. The rule that covers both without excusing either is simply that the
   * root appears SOMEWHERE in the client's rows, which the path table supplies.
   */
  it.each(DOCS)('%s names the real skill root for every client that has one', (doc) => {
    const markdown = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
    for (const capability of CLIENT_CAPABILITIES) {
      if (!capability.skillRoot) continue;
      const rows = tableRows(markdown, ROW_LABEL[capability.id]!);
      expect(
        rows.some((row) => row.includes(capability.skillRoot!)),
        `${doc}: ${ROW_LABEL[capability.id]} must name its skill root ${capability.skillRoot}; rows were ${JSON.stringify(rows)}`,
      ).toBe(true);
      // ...and EVERY skills path it names must be that one. Presence alone is not enough: the
      // client appears in three tables, so a wrong path in the install table is still covered
      // by a correct one elsewhere — which is how `~/.wrong/path/` survived the first fix.
      for (const row of rows) {
        for (const named of row.matchAll(/`(~\/[^`]*skills[^`]*)`/g)) {
          expect(named[1]!.replace(/\/$/, ''), `${doc}: ${ROW_LABEL[capability.id]} names skills path ${named[1]}, not ${capability.skillRoot}`)
            .toBe(capability.skillRoot);
        }
      }
    }
  });

  it.each(DOCS)('%s shows no skill root for a client that installs none', (doc) => {
    // The inverse, previously unchecked: a client with `skillRoot: null` gets no skills at all,
    // so a row naming one would promise an install that never happens — the same failure as the
    // VS Code MCP row this file was written for, in the other column.
    const markdown = readFileSync(new URL(`../../../${doc}`, import.meta.url), 'utf8');
    for (const capability of CLIENT_CAPABILITIES) {
      if (capability.skillRoot) continue;
      for (const row of tableRows(markdown, ROW_LABEL[capability.id]!)) {
        expect(row, `${doc}: ${ROW_LABEL[capability.id]} installs no skills but its row names a skills path`)
          .not.toMatch(/skills\//);
      }
    }
  });
});
