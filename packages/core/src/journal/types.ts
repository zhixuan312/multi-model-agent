export const EDGE_TYPES = ['supersedes','refines','relates','depends-on','contradicts','parent'] as const;
export type EdgeType = typeof EDGE_TYPES[number];
export const STATUS_VALUES = ['adopted','dropped','inconclusive','superseded'] as const;
export type JournalStatus = typeof STATUS_VALUES[number];

export interface JournalEdge { type: EdgeType; target: string; }

export const isEdgeType = (v: unknown): v is EdgeType => EDGE_TYPES.includes(v as EdgeType);
export const isStatus = (v: unknown): v is JournalStatus => STATUS_VALUES.includes(v as JournalStatus);
