import type { ZodSchema } from 'zod';
import type { ToolCategory } from '../routing/escalation-policy.js';

export interface SurfaceEntry {
  routeName: string;
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
