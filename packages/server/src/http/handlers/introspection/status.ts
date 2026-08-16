// packages/server/src/http/handlers/introspection/status.ts
import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { sendJson } from '../../errors.js';
import type { RawHandler } from '../../types.js';
import type { ExecutionRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ProjectRegistry } from '../../../application/project-registry.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { resolveConfiguredAuthMode } from '@zhixuan92/multi-model-agent-core';
import { deriveSkillManifestInfo } from '../../../skill-install/skill-drift.js';

interface StatusHandlerDeps {
  executionRegistry: ExecutionRegistry;
  projectRegistry: ProjectRegistry;
  serverStartedAt: number;
  bind: string;
  version: string;
  config?: MultiModelConfig;
  /**
   * Where the install manifest is read from. Production omits it, so
   * `deriveSkillManifestInfo` falls back to the real `~/.mma`.
   *
   * `deriveSkillManifestInfo` has always accepted a `homeDir`; this handler never passed one, so
   * `GET /status` could only ever report whatever happened to be installed for whoever ran it.
   * Its test admitted as much in a comment — "we can't assert null with certainty if the
   * developer has the skill installed" — and settled for `sv === null || typeof sv === 'string'`,
   * which holds for almost any value. The documented behaviour ("null/null when no skills are
   * installed") had no coverage because it was unreachable, not because it was unimportant.
   */
  homeDir?: string;
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
      executionRegistry,
      projectRegistry,
      serverStartedAt,
      bind,
      version,
      config,
      homeDir,
    } = deps;

    const now = Date.now();
    // `config.agents` and each tier inside it are optional at the schema level
    // so a machine can record a client roster before choosing models; the daemon
    // refuses to start unless all three tiers are present, so a tier reads as
    // null only on a config-less or half-configured status read.
    //
    // No cross-tier substitution: reporting `complex` under the name `main`
    // would tell an operator a tier is configured when it is not, and `main` is
    // now the value every run's cost baseline is priced against.
    const describeTier = (tier?: Parameters<typeof resolveConfiguredAuthMode>[0] & { type: string }) =>
      (tier ? { type: tier.type, mode: resolveConfiguredAuthMode(tier) } : null);
    const agents = config?.agents
      ? {
          standard: describeTier(config.agents.standard),
          complex: describeTier(config.agents.complex),
          main: describeTier(config.agents.main),
        }
      : undefined;

    // ── Counters ──────────────────────────────────────────────────────────────
    const projects: {
      cwd: string;
      createdAt: number;
      lastActivityAt: number;
      activeTasks: number;
      contextBlockCount: number;
    }[] = [];

    for (const [, pc] of projectRegistry.entries()) {
      const pcActiveTasks = executionRegistry.countActive(pc.cwd);

      projects.push({
        cwd: pc.cwd,
        createdAt: pc.createdAt,
        lastActivityAt: pc.lastActivityAt,
        activeTasks: pcActiveTasks,
        contextBlockCount: pc.contextBlocks.size,
      });
    }

    // ── Task lists ───────────────────────────────────────────────────────────
    const inflight = executionRegistry.allInFlight().map(entry => ({
      executionId: entry.executionId,
      tool: entry.tool,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      state: entry.state,
    }));

    // ── Skill manifest ────────────────────────────────────────────────────────
    // Derived from the real install-manifest.json (single source of truth shared
    // with serve-startup drift detection). Null/null when no skills are installed.
    const { skillVersion, skillCompatible } = deriveSkillManifestInfo(homeDir);

    sendJson(res, 200, {
      version,
      pid: process.pid,
      bind,
      uptimeMs: now - serverStartedAt,
      auth: { enabled: true },
      ...(agents && { agents }),
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
