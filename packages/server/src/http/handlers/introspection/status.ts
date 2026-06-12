// packages/server/src/http/handlers/introspection/status.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendError, sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ProjectRegistry } from '../../project-registry.js';

/**
 * The skill manifest is installed by the `sync-skills` CLI.
 * We read it at /status request time — if absent, skillVersion and
 * skillCompatible are both null.
 */
const SKILL_MANIFEST_PATH = join(homedir(), '.multi-model', 'skills-install-manifest.json');

/**
 * SemVer range this server is compatible with for installed skills.
 * A manifest version that does NOT match means the skill is out of date.
 */
export const SKILL_VERSION_COMPATIBLE = '>=3.0.0 <4.0.0';

/** Simple semver range check: parses major.minor.patch and checks >=min <max. */
function checkSkillCompatible(version: string): boolean {
  // Parse the version string
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [, majorStr, minorStr, patchStr] = match;
  const major = parseInt(majorStr!, 10);
  const minor = parseInt(minorStr!, 10);
  const patch = parseInt(patchStr!, 10);

  // Must be >= 3.0.0
  if (major < 3) return false;
  if (major === 3 && minor === 0 && patch < 0) return false;

  // Must be < 4.0.0
  if (major >= 4) return false;

  return true;
}

interface SkillManifestInfo {
  skillVersion: string | null;
  skillCompatible: boolean | null;
}

function readSkillManifest(): SkillManifestInfo {
  try {
    const raw = readFileSync(SKILL_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    const skillVersion = typeof manifest['skillVersion'] === 'string'
      ? manifest['skillVersion']
      : null;

    if (skillVersion === null) {
      return { skillVersion: null, skillCompatible: null };
    }

    let skillCompatible: boolean | null;
    try {
      skillCompatible = checkSkillCompatible(skillVersion);
    } catch {
      // Version parse failed — report incompatible
      skillCompatible = false;
    }

    return { skillVersion, skillCompatible };
  } catch {
    // File absent or unreadable
    return { skillVersion: null, skillCompatible: null };
  }
}

export interface StatusHandlerDeps {
  taskRegistry: TaskRegistry;
  projectRegistry: ProjectRegistry;
  serverStartedAt: number;
  bind: string;
  version: string;
}

/**
 * GET /status — operator introspection endpoint.
 *
 * Requires both:
 *  - Bearer auth (enforced by server pipeline, step 4)
 *  - Loopback origin (enforced by server pipeline, step 3 — LOOPBACK_ONLY_PATHS)
 *
 * Returns the status shape.
 */
export function buildStatusHandler(deps: StatusHandlerDeps): RawHandler {
  return (_req: IncomingMessage, res: ServerResponse) => {
    const {
      taskRegistry,
      projectRegistry,
      serverStartedAt,
      bind,
      version,
    } = deps;

    const now = Date.now();

    // ── Counters ──────────────────────────────────────────────────────────────
    let activeRequests = 0;

    const projects: {
      cwd: string;
      createdAt: number;
      lastActivityAt: number;
      activeRequests: number;
      activeTasks: number;
      contextBlockCount: number;
    }[] = [];

    for (const [, pc] of projectRegistry.entries()) {
      const pcActiveTasks = taskRegistry.countActive(pc.cwd);
      activeRequests += pc.activeRequests;

      projects.push({
        cwd: pc.cwd,
        createdAt: pc.createdAt,
        lastActivityAt: pc.lastActivityAt,
        activeRequests: pc.activeRequests,
        activeTasks: pcActiveTasks,
        contextBlockCount: pc.contextBlocks.size,
      });
    }

    // ── Task lists ───────────────────────────────────────────────────────────
    const inflight = taskRegistry.allInFlight().map(entry => ({
      taskId: entry.taskId,
      tool: entry.tool,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      state: entry.state,
    }));

    // ── Skill manifest ────────────────────────────────────────────────────────
    const { skillVersion, skillCompatible } = readSkillManifest();

    sendJson(res, 200, {
      version,
      pid: process.pid,
      bind,
      uptimeMs: now - serverStartedAt,
      auth: { enabled: true },
      counters: {
        projectCount: projectRegistry.size,
        activeRequests,
        activeTasks: inflight.length,
      },
      projects,
      inflight,
      skillVersion,
      skillCompatible,
    });
  };
}
