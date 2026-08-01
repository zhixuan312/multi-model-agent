import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Every skill that dispatches work must tell the agent to prefer the MCP tools.
 *
 * Claude Desktop runs Claude Code skills AND MCP servers from the same `~/.claude` install,
 * with no per-client toggle — Desktop bundles Claude Code and reads the same
 * `settings.json`/`enabledPlugins`. So both surfaces are always present together and the model
 * picks between them. Observed live: consecutive runs of the same prompt took different
 * routes, and the curl route renders no execution monitor because the host never learns a task
 * is running.
 *
 * Since the host offers no lever, the skills have to defer. This test stops a new dispatching
 * skill from shipping without that guidance — the failure mode is silent (everything still
 * works, the user just loses the App and pays a model turn per progress update), so nothing
 * else would catch it.
 */
const SKILLS_DIR = 'packages/server/src/skills';

/** The router documents a health-check curl, not a dispatch, so it carries its own prose. */
const ROUTER = 'multi-model-agent';

async function skillDirs(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name);
}

/** A skill DISPATCHES if it documents a POST to a task-creating route. */
function dispatches(md: string): boolean {
  return /curl[\s\S]{0,400}-X POST/.test(md) || /@include _shared\/auth\.md/.test(md);
}

describe('contract: dispatching skills prefer the MCP transport', () => {
  it('every dispatching skill includes the prefer-mcp guidance', async () => {
    const missing: string[] = [];
    for (const name of await skillDirs()) {
      if (name === ROUTER) continue;
      let md: string;
      try {
        md = await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
      } catch {
        continue; // not every skill dir ships a SKILL.md
      }
      if (dispatches(md) && !md.includes('@include _shared/prefer-mcp.md')) missing.push(name);
    }
    expect(missing, `dispatching skills missing @include _shared/prefer-mcp.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('the guidance names the MCP tool and states when the curl fallback is correct', async () => {
    const md = await readFile(join(SKILLS_DIR, '_shared', 'prefer-mcp.md'), 'utf8');
    expect(md).toContain('mma_run');
    expect(md).toMatch(/mma_task_get/);
    // It must say WHEN curl is still right, or the agent cannot act on the rule in a
    // terminal or CI session where no MCP connection exists.
    expect(md).toMatch(/fallback|genuinely absent|no MCP/i);
  });

  it('the router points at the MCP transport before routing to any sub-skill', async () => {
    const md = await readFile(join(SKILLS_DIR, ROUTER, 'SKILL.md'), 'utf8');
    const idx = md.indexOf('mma_run');
    expect(idx, 'router must mention mma_run').toBeGreaterThan(-1);
    // Before the skill map, so the preference is read before a route is chosen.
    expect(idx).toBeLessThan(md.indexOf('## Skill map'));
  });
});
