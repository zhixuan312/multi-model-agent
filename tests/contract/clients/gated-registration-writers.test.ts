import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { writerForClient } from '../../../packages/server/src/provisioning/writers/registry.js';
import type { ClientId } from '@zhixuan92/multi-model-agent-core';

/**
 * The evidence gate: no registration writer may exist for a client whose path and
 * schema were not verified against that vendor's own documentation.
 *
 * This test derives what it checks FROM the evidence artifact rather than from a
 * hardcoded list, because a hardcoded list is not a gate — it is a snapshot of the
 * clients someone remembered. Adding a client section to the artifact, or flipping
 * one from BLOCKED to ready, fails here until the capability row and the writer
 * registry agree with it.
 */
const EVIDENCE_URL = new URL('../../../docs/verification/mcp-client-registration-profiles.md', import.meta.url);

/** The artifact writes clients by their human name; capability rows use ClientId.
 *  A name here with no section, or a section with no entry here, fails below. */
const DISPLAY_NAME_TO_ID: Readonly<Record<string, ClientId>> = {
  'VS Code': 'vscode',
  Antigravity: 'antigravity',
  opencode: 'opencode',
  Windsurf: 'windsurf',
};

/** `| <Client> | … | ready |` / `| … | **BLOCKED** |` rows of the Summary table. */
function parseSummary(markdown: string): Array<{ name: string; ready: boolean }> {
  const summary = markdown.slice(markdown.indexOf('## Summary'));
  return summary
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---') && !line.startsWith('| Client'))
    .map((line) => {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      return { name: cells[0]!, ready: cells[cells.length - 1] === 'ready' };
    });
}

describe('contract: evidence-gated registration writers', () => {
  it('agrees with the evidence artifact about every client it covers', async () => {
    const evidence = await readFile(EVIDENCE_URL, 'utf8');
    const rows = parseSummary(evidence);
    expect(rows.length, 'the Summary table must be parseable').toBeGreaterThan(0);

    // The artifact's own client sections and this mapping must stay in step, or a
    // newly documented client would silently escape every assertion below.
    const sections = [...evidence.matchAll(/^## (?!Summary)(.+)$/gm)].map((m) => m[1]!.trim());
    expect([...sections].sort()).toEqual(Object.keys(DISPLAY_NAME_TO_ID).sort());
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(DISPLAY_NAME_TO_ID).sort());

    for (const { name, ready } of rows) {
      const clientId = DISPLAY_NAME_TO_ID[name]!;
      const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === clientId)!;

      if (ready) {
        expect(writerForClient(clientId), `${name} is marked ready and must have a writer`).toBeDefined();
        const profile = capability.registrationProfile;
        expect(profile, `${name} is marked ready and must record its evidence`).toBeDefined();
        expect(profile!.verifiedBy).toMatch(/^https:\/\//);
        // The URL must appear in the artifact itself, so a profile cannot cite a
        // source this document never examined.
        expect(evidence).toContain(profile!.verifiedBy);
        expect(profile!.path).toMatch(/\S/);
        expect(profile!.ownershipRecognizer).toMatch(/\S/);
        expect(profile!.dynamicCredentialMechanism).toMatch(/\S/);
        expect(capability.mcpConfigPaths.length, `${name} must carry its verified path`).toBeGreaterThan(0);
      } else {
        // Blocked stays blocked in all three places at once: no writer, no
        // profile that could not be backed by evidence, and the uniform
        // "unverified" signal on the row itself.
        expect(writerForClient(clientId), `${name} is BLOCKED and must have no writer`).toBeUndefined();
        expect(capability.registrationProfile).toBeUndefined();
        expect(capability.mcpConfigPaths).toEqual([]);
      }
    }
  });

  it('never lets a writer exist for a client carrying the unverified signal', () => {
    // Wider than the artifact: this holds for every row, including the five
    // writers that predate this gate. An empty `mcpConfigPaths` means the path is
    // unconfirmed, and an unconfirmed path must never be written to.
    for (const capability of CLIENT_CAPABILITIES) {
      if (capability.mcpConfigPaths.length === 0) {
        expect(writerForClient(capability.id), `${capability.id} has no verified path`).toBeUndefined();
      }
    }
  });
});
