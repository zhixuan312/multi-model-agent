import type { BriefSlotFiller } from '../brief-compiler.js';

export interface ExploreInput {
  topic: string;
  cwd?: string;
}

export interface ExploreBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'none';
  contextBlockIds: string[];
  researchAdapter: 'internal' | 'external' | 'synth';
}

export const exploreSlot: BriefSlotFiller<ExploreInput, ExploreBrief[]> = (input) => {
  const cwd = input.cwd ?? process.cwd();
  return [
    {
      taskIndex: 0,
      brief: `Explore '${input.topic}' from internal codebase`,
      cwd,
      agentType: 'complex',
      reviewPolicy: 'none',
      contextBlockIds: [],
      researchAdapter: 'internal',
    },
    {
      taskIndex: 1,
      brief: `Explore '${input.topic}' from external sources`,
      cwd,
      agentType: 'complex',
      reviewPolicy: 'none',
      contextBlockIds: [],
      researchAdapter: 'external',
    },
    {
      taskIndex: 2,
      brief: `Synthesize internal + external findings for '${input.topic}'`,
      cwd,
      agentType: 'complex',
      reviewPolicy: 'none',
      contextBlockIds: [],
      researchAdapter: 'synth',
    },
  ];
};
