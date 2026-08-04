import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const profilePath = new URL('../../../docs/verification/mcp-client-registration-profiles.md', import.meta.url);

describe('contract: gated MCP client registration profiles', () => {
  it('records primary-source-ready writer inputs for every gated client', async () => {
    const document = await readFile(profilePath, 'utf8');
    for (const client of ['VS Code', 'opencode', 'Windsurf']) {
      const start = document.search(new RegExp(`^##\\s+${client}\\b`, 'mi'));
      // Index [1], not [0]: document.slice(start) BEGINS with the matched "## "
      // heading, so splitting on that same delimiter always yields '' at index 0.
      const section = start === -1 ? '' : document.slice(start).split(/^##\s+/m)[1] ?? '';
      expect(section, `missing ${client} profile`).not.toBe('');
      expect(section).toMatch(/https:\/\//i);
      expect(section).toMatch(/user[- ]level|global/i);
      expect(section).toMatch(/path|location/i);
      expect(section).toMatch(/schema|key|mcpServers/i);
      expect(section).toMatch(/own(?:ed|ership)|recognis/i);
      expect(section).toMatch(/token|credential|environment|helper/i);
    }
    // The artifact records mechanisms, never secrets.
    expect(document).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/);
  });

  it('cites only vendor-owned documentation for each gated client', async () => {
    const document = await readFile(profilePath, 'utf8');
    // Every host cited must belong to the vendor whose client it documents.
    // docs.devin.ai is included because docs.windsurf.com 307-redirects to it
    // (Cognition acquired Windsurf), which the artifact records as provenance.
    const vendorHosts = ['code.visualstudio.com', 'opencode.ai', 'docs.devin.ai', 'docs.windsurf.com'];
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
    expect(document).toMatch(/^\*\*Status: BLOCKED/mi);
    expect((document.match(/^\*\*Status: VERIFIED/gmi) ?? []).length).toBe(2);
  });
});
