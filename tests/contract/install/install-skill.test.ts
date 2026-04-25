// Pins the file-set produced by mmagent install-skill against a temp
// home directory, per target client. Ch 7 Task 39 split install-skill.ts
// across discover/manifest-resolve/orchestrate; this test is the
// behavioral guardrail.
//
// Each per-client golden is the sorted list of relative paths the
// installer writes under the temp homeDir for the `mma-delegate` skill.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { doInstall, type InstallResult } from '../../../packages/server/src/install/orchestrate.js';
import type { Client } from '../../../packages/server/src/install/manifest.js';

function listAll(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  }
  walk(root);
  return out.sort();
}

const SKILLS_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'mma-skills-fixture-'));
const SKILL_MD = `---
name: mma-delegate
description: Test skill
when_to_use: Test
version: "0.0.0-test"
---

# Test skill body
`;

import { mkdirSync } from 'node:fs';
mkdirSync(join(SKILLS_FIXTURE_ROOT, 'mma-delegate'), { recursive: true });
writeFileSync(join(SKILLS_FIXTURE_ROOT, 'mma-delegate', 'SKILL.md'), SKILL_MD);

interface ClientCase {
  client: Client;
  /** Paths (relative to homeDir or cwd as applicable) we expect the writer to create. */
  expectedSubpath: string;
}

const CLIENT_CASES: ClientCase[] = [
  { client: 'claude-code', expectedSubpath: '.claude/skills' },
  { client: 'gemini', expectedSubpath: '.gemini/extensions' },
  { client: 'codex', expectedSubpath: '.codex' },
];

describe('contract: install-skill file-set per client', () => {
  for (const { client, expectedSubpath } of CLIENT_CASES) {
    it(`writes mma-delegate to ${client} under ${expectedSubpath}`, () => {
      const homeDir = mkdtempSync(join(tmpdir(), `mma-install-${client}-`));
      try {
        const result: InstallResult = doInstall(
          'mma-delegate',
          [client],
          {
            dryRun: false,
            homeDir,
            skillsRoot: SKILLS_FIXTURE_ROOT,
            version: '0.0.0-test',
          },
        );

        expect(result.action).toBe('installed');
        expect(result.targets).toEqual([client]);
        expect(result.skipped).toEqual([]);

        const subRoot = join(homeDir, expectedSubpath);
        const writtenPaths = listAll(subRoot);
        expect(writtenPaths.length, `expected ${client} to write at least one file under ${expectedSubpath}`).toBeGreaterThan(0);

        // Every written file is non-empty and contains the skill name marker.
        for (const p of writtenPaths) {
          const fullPath = join(subRoot, p);
          const content = readFileSync(fullPath, 'utf8');
          expect(content.length, `${p} should be non-empty`).toBeGreaterThan(0);
        }
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  }
});
