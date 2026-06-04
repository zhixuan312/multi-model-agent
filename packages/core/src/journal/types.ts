export const EDGE_TYPES = ['supersedes','refines','relates','depends-on','contradicts','parent'] as const;
export type EdgeType = typeof EDGE_TYPES[number];
export const STATUS_VALUES = ['adopted','dropped','inconclusive','superseded'] as const;
export type JournalStatus = typeof STATUS_VALUES[number];

export interface JournalEdge { type: EdgeType; target: string; }
export interface JournalNode {
  id: string;            // zero-padded 4-digit
  title: string;
  status: JournalStatus;
  tags: string[];        // lowercase kebab-case
  date: string;          // ISO-8601 (YYYY-MM-DD)
  links: JournalEdge[];
  supersededBy: string | null;
  context: string;       // ## Context body
  consequences: string;  // ## Consequences body
}

export const isEdgeType = (v: unknown): v is EdgeType => EDGE_TYPES.includes(v as EdgeType);
export const isStatus = (v: unknown): v is JournalStatus => STATUS_VALUES.includes(v as JournalStatus);
