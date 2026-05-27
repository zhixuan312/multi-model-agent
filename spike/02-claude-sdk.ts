// AC-S2a: the claude-agent-SDK's query() (which spawns its own subprocess) works under Bun.
import { query } from "@anthropic-ai/claude-agent-sdk";

let sawEvent = false;
let firstType = "";
try {
  for await (const msg of query({ prompt: "Reply with exactly: ok" })) {
    sawEvent = true;
    firstType = (msg as { type?: string })?.type ?? typeof msg;
    console.log("first SDK event type:", firstType);
    break; // one streamed event is enough for the feasibility gate
  }
} catch (e) {
  console.error("claude SDK under Bun threw:", (e as Error).message);
}
console.log("AC-S2a sawEvent:", sawEvent);
if (!sawEvent) { console.error("FAIL AC-S2a: claude-agent-sdk did not stream under Bun"); process.exit(1); }
console.log("PASS AC-S2a");
