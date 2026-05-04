export interface ToolInvocation {
  name: string;
  turnIndex: number;
  input: unknown;
  result: unknown;
  durationMs: number;
}

export class ToolTracker {
  private records: ToolInvocation[] = [];

  record(inv: ToolInvocation): void {
    this.records.push(inv);
  }

  forTurn(turnIndex: number): ToolInvocation[] {
    return this.records.filter((r) => r.turnIndex === turnIndex);
  }

  all(): ToolInvocation[] {
    return [...this.records];
  }
}
