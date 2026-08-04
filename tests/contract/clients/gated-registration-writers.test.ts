import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CLIENT_CAPABILITIES } from '../../../packages/server/src/provisioning/capability-registry.js';
import { writerForClient } from '../../../packages/server/src/provisioning/registration-writer.js';

describe('contract: evidence-gated registration writers', () => {
  it('exposes a writer only for the clients Task I-1 verified as primary-source ready', async () => {
    const evidence = await readFile(new URL('../../../docs/verification/mcp-client-registration-profiles.md', import.meta.url), 'utf8');
    for (const clientId of ['opencode', 'windsurf'] as const) {
      const capability = CLIENT_CAPABILITIES.find((candidate) => candidate.id === clientId)!;
      expect(capability.registrationProfile?.verifiedBy).toMatch(/^https:\/\//);
      expect(capability.registrationProfile?.path).toMatch(/\S/);
      expect(capability.registrationProfile?.ownershipRecognizer).toMatch(/\S/);
      expect(capability.registrationProfile?.dynamicCredentialMechanism).toMatch(/\S/);
      expect(evidence).toContain(capability.registrationProfile?.verifiedBy);
      expect(writerForClient(clientId)).toBeDefined();
    }

    // VS Code's user-level path is still not published by the vendor (see the
    // evidence artifact's "Unresolved" section) — it stays BLOCKED. No writer
    // may exist for it, and its capability row keeps the uniform
    // "unverified" signal (`mcpConfigPaths: []`) rather than gaining a
    // registrationProfile that could not be backed by real evidence.
    const vscode = CLIENT_CAPABILITIES.find((candidate) => candidate.id === 'vscode')!;
    expect(vscode.mcpConfigPaths).toEqual([]);
    expect(vscode.registrationProfile).toBeUndefined();
    expect(writerForClient('vscode')).toBeUndefined();
  });
});