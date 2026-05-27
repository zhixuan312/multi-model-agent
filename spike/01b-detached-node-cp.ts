// Does Bun's node:child_process shim support detached process groups + process.kill(-pid)?
import { spawn } from "node:child_process";

const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
  stdio: ["ignore", "pipe", "ignore"],
  detached: true, // create a new process group, so -pid signals the whole group
});

const grandchildPid: number = await new Promise((resolve) => {
  child.stdout!.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
});
console.log("child pid:", child.pid, "grandchild pid:", grandchildPid);

try {
  process.kill(-child.pid!, "SIGTERM");
  console.log("sent SIGTERM to group", -child.pid!);
} catch (e) {
  console.error("group kill threw:", (e as Error).message);
}

await new Promise((r) => setTimeout(r, 800));
let alive = true;
try { process.kill(grandchildPid, 0); } catch { alive = false; }
console.log("grandchildAlive after group SIGTERM:", alive);
if (alive) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} console.error("FAIL: node:child_process detached group kill did NOT work under Bun"); process.exit(1); }
console.log("PASS: node:child_process detached + process.kill(-pid) WORKS under Bun");
