/**
 * TextScratchpad — accumulates assistant text emissions across turns of a
 * sub-agent run. The runner appends text from each turn so that, on any
 * termination (clean exit, abort, timeout, error), the salvage layer can
 * return the best buffered text instead of an empty string.
 *
 * See docs/superpowers/specs/2026-04-10-subagent-completion-supervision-design.md
 * Part A.2.1 for the design rationale.
 */
export class TextScratchpad {
  private turns: { turn: number; text: string }[] = [];

  /** Record a non-empty text emission for the given turn. Empty/whitespace
   *  emissions are ignored — they have no salvage value. */
  append(turn: number, text: string): void {
    if (!text || text.trim().length === 0) return;
    this.turns.push({ turn, text });
  }

  isEmpty(): boolean {
    return this.turns.length === 0;
  }

  /** All buffered text concatenated, in turn order, separated by a fixed
   *  delimiter. Used as the salvage payload when no clean final answer
   *  was produced. */
  toString(): string {
    return this.turns.map((t) => t.text).join('\n\n---\n\n');
  }

  /** The most recent buffered emission. Empty string if isEmpty(). */
  latest(): string {
    return this.turns.length === 0 ? '' : this.turns[this.turns.length - 1].text;
  }

  /** The longest buffered emission across all turns. Empty string if
   *  isEmpty(). Used by the escalation layer to pick the best salvageable
   *  result across multiple provider attempts. */
  longest(): string {
    if (this.turns.length === 0) return '';
    let best = this.turns[0].text;
    for (const t of this.turns) {
      if (t.text.length > best.length) best = t.text;
    }
    return best;
  }

  reset(): void {
    this.turns = [];
  }
}
