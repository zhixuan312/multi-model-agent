import type { ZodSchema } from 'zod';
import type { ToolCategory } from '../escalation/escalation-policy.js';

export interface SurfaceEntry {
  routeName: string;
  /** HTTP method on the public route. Most tools are POST. */
  httpMethod: 'POST' | 'GET' | 'DELETE';
  /** HTTP URL path. Differs from routeName when the wire form uses
   * hyphens (e.g. `/execute-plan` for `execute_plan`) or a different
   * surface name (e.g. `/retry` for `retry_tasks`). */
  httpPath: string;
  /** Tier the tool registration lives in: `tool` (POST /<path>) or
   * `control` (sync state op like /context-blocks). Tool-tier entries
   * drive standard tool-handler registration; control-tier entries are
   * handled separately by registerControlHandlers. */
  surface: 'tool' | 'control';
  schema: ZodSchema<any>;
  toolCategory: ToolCategory;
  agentTypeDefault: 'standard' | 'complex';
  agentTypeOverridable: boolean;
  responseShapeName: string;
}

export class ToolSurfaceRegistry {
  private entries = new Map<string, SurfaceEntry>();

  register(entry: SurfaceEntry): void {
    if (this.entries.has(entry.routeName)) {
      throw new Error(`route '${entry.routeName}' already registered`);
    }
    this.entries.set(entry.routeName, entry);
  }

  get(routeName: string): SurfaceEntry | undefined {
    return this.entries.get(routeName);
  }

  list(): SurfaceEntry[] {
    return [...this.entries.values()];
  }
}
