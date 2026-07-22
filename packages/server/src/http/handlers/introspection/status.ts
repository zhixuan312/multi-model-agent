// packages/server/src/http/handlers/introspection/status.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ProjectRegistry } from '../../project-registry.js';
import { deriveSkillManifestInfo } from '../../../skill-install/skill-drift.js';

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
    const projects: {
      cwd: string;
      createdAt: number;
      lastActivityAt: number;
      activeTasks: number;
      contextBlockCount: number;
    }[] = [];

    for (const [, pc] of projectRegistry.entries()) {
      const pcActiveTasks = taskRegistry.countActive(pc.cwd);

      projects.push({
        cwd: pc.cwd,
        createdAt: pc.createdAt,
        lastActivityAt: pc.lastActivityAt,
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
    // Derived from the real install-manifest.json (single source of truth shared
    // with serve-startup drift detection). Null/null when no skills are installed.
    const { skillVersion, skillCompatible } = deriveSkillManifestInfo();

    sendJson(res, 200, {
      version,
      pid: process.pid,
      bind,
      uptimeMs: now - serverStartedAt,
      auth: { enabled: true },
      counters: {
        projectCount: projectRegistry.size,
        activeTasks: inflight.length,
      },
      projects,
      inflight,
      skillVersion,
      skillCompatible,
    });
  };
}
