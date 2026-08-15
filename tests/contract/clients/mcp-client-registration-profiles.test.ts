import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const profilePath = new URL('../../../docs/verification/mcp-client-registration-profiles.md', import.meta.url);

/**
 * The clients this artifact covers, read from the artifact's own Summary table.
 *
 * This was the literal `['VS Code', 'opencode', 'Windsurf']` — which omitted Antigravity, so the
 * completeness checks below (cites a vendor URL, names a path, a schema, an ownership recogniser
 * and a credential mechanism) never ran against one of the four profiles. Its sibling
 * `gated-registration-writers.test.ts` says the reason in as many words: "a hardcoded list is not
 * a gate — it is a snapshot of the clients someone remembered." The gate and the completeness
 * check have to read the same list, and there is only one list.
 */
function summaryRows(markdown: string): Array<{ name: string; ready: boolean }> {
  const summary = markdown.slice(markdown.indexOf('## Summary'));
  return summary
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---') && !line.startsWith('| Client'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      return { name: cells[0]!, ready: cells[cells.length - 1] === 'ready' };
    })
    .filter((row) => row.name);
}

function coveredClients(markdown: string): string[] {
  return summaryRows(markdown).map((row) => row.name);
}

function readySummaryClients(markdown: string): string[] {
  return summaryRows(markdown).filter((row) => row.ready).map((row) => row.name);
}

describe('contract: gated MCP client registration profiles', () => {
  /** The section body for a client, or '' when the artifact has no section for it. */
  function profileSection(document: string, client: string): string {
    const start = document.search(new RegExp(`^##\\s+${client}\\b`, 'mi'));
    // Index [1], not [0]: document.slice(start) BEGINS with the matched "## "
    // heading, so splitting on that same delimiter always yields '' at index 0.
    return start === -1 ? '' : document.slice(start).split(/^##\s+/m)[1] ?? '';
  }

  it('gives every covered client a section citing a vendor source', async () => {
    const document = await readFile(profilePath, 'utf8');
    const clients = coveredClients(document);
    expect(clients.length, 'the Summary table names no clients — the parse is broken').toBeGreaterThan(0);
    for (const client of clients) {
      const section = profileSection(document, client);
      expect(section, `missing ${client} profile`).not.toBe('');
      expect(section, `${client} cites no source`).toMatch(/https:\/\//i);
    }
    // The artifact records mechanisms, never secrets.
    expect(document).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
  });

  /**
   * The five writer inputs are required of a READY profile only.
   *
   * A BLOCKED client has, by definition, no verified credential mechanism or ownership
   * recogniser — Antigravity's section documents a vendor migration that removed the
   * integration model outright. Demanding them of every section is why the list of clients
   * here was hardcoded to the three that could satisfy it, which quietly dropped Antigravity
   * from the source-citation and secret checks above as well. Splitting by status covers all
   * four with the requirements that actually apply to each.
   */
  it('records every writer input for a client marked ready', async () => {
    const document = await readFile(profilePath, 'utf8');
    const ready = readySummaryClients(document);
    expect(ready.length, 'no client is marked ready — the Summary parse is broken').toBeGreaterThan(0);
    for (const client of ready) {
      const section = profileSection(document, client);
      expect(section, `${client} is ready but names no user-level path`).toMatch(/user[- ]level|global/i);
      expect(section, `${client} is ready but names no path`).toMatch(/path|location/i);
      expect(section, `${client} is ready but names no schema`).toMatch(/schema|key|mcpServers/i);
      expect(section, `${client} is ready but names no ownership recogniser`).toMatch(/own(?:ed|ership)|recognis/i);
      expect(section, `${client} is ready but names no credential mechanism`).toMatch(/token|credential|environment|helper/i);
    }
  });

  it('cites only vendor-owned documentation for each gated client', async () => {
    const document = await readFile(profilePath, 'utf8');
    // Every host cited must belong to the vendor whose client it documents.
    // docs.devin.ai is included because docs.windsurf.com 307-redirects to it
    // (Cognition acquired Windsurf), which the artifact records as provenance.
    // developers.googleblog.com is Google's own channel and is where the Gemini
    // CLI -> Antigravity CLI retirement date is published; antigravity.google is
    // that product's own docs host.
    const vendorHosts = [
      'code.visualstudio.com', 'opencode.ai', 'docs.devin.ai', 'docs.windsurf.com',
      'antigravity.google', 'developers.googleblog.com',
    ];
    const urls = document.match(/https:\/\/[^\s)]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const host = new URL(url).host;
      expect(vendorHosts, `non-vendor source cited: ${url}`).toContain(host);
    }
  });

  it('states an explicit blocked-or-ready status for every gated client', async () => {
    const document = await readFile(profilePath, 'utf8');
    // A client is only unblocked by an explicit VERIFIED status. Silence is not
    // consent: an unstated status must never read as permission to write.
    // Every covered client states one, and the two states partition the set — a literal count
    // of VERIFIED sections restates the Summary table's own arithmetic in a second place.
    const statuses = document.match(/^\*\*Status: (BLOCKED|VERIFIED)/gmi) ?? [];
    expect(statuses).toHaveLength(coveredClients(document).length);
    expect(statuses.some((status) => /BLOCKED/i.test(status)), 'silence is not consent').toBe(true);
  });
});
