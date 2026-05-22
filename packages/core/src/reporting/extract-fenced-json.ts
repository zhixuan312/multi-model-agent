/**
 * Extract + parse the JSON object inside a ```json … ``` fenced block.
 * Throws an Error tagged with `label` when the block is missing or unparseable,
 * so each call site keeps a route-specific message.
 */
export function extractFencedJson(text: string, label: string): unknown {
  const m = /```json\n([\s\S]+?)\n```/.exec(text ?? '');
  if (!m) throw new Error(`${label}: no fenced JSON block found`);
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`${label}: fenced JSON did not parse — ${e instanceof Error ? e.message : String(e)}`);
  }
}
