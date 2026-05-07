import type { BriefSlotFiller } from '../brief-compiler.js';

export interface RegisterContextBlockInput {
  content: string;
  ttlMs?: number;
  cwd?: string;
}

export interface RegisterContextBlockBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'standard' | 'complex';
  reviewPolicy: 'full' | 'quality_only' | 'diff_only' | 'none';
  contextBlockIds: string[];
  inheritedToolCategory: 'assist';
}

// register-context-block is a synchronous state op — it does not
// dispatch a sub-agent. This slot returns a single zero-cost brief
// so the framework can resolve a slot per route uniformly.
export function makeRegisterContextBlockSlot(): BriefSlotFiller<RegisterContextBlockInput, RegisterContextBlockBrief[]> {
  return (input) => {
    return [{
      taskIndex: 0,
      brief: input.content,
      cwd: input.cwd ?? process.cwd(),
      agentType: 'standard',
      reviewPolicy: 'none',
      contextBlockIds: [],
      inheritedToolCategory: 'assist',
    }];
  };
}
