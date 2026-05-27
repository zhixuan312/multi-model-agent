// AC-S1: Bun.spawn detached group + process.kill(-pid, SIGTERM) kills the whole tree.
const proc = Bun.spawn(["sh", "-c", "sleep 300 & echo $!; wait"], { stdout: "pipe", stderr: "pipe" });
const { value } = await proc.stdout.getReader().read();
const grandchildPid = Number(new TextDecoder().decode(value!).trim());
console.log("child pid:", proc.pid, "grandchild pid:", grandchildPid);
if (typeof proc.pid !== "number") throw new Error("no child pid");
try {
  process.kill(-proc.pid, "SIGTERM");
  console.log("sent SIGTERM to process group", -proc.pid);
} catch (e) {
  console.log("group kill threw, fallback proc.kill:", (e as Error).message);
  proc.kill("SIGTERM");
}
await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 5000))]);
let alive = true;
try { process.kill(grandchildPid, 0); } catch { alive = false; }
console.log("child exitCode:", proc.exitCode, "grandchildAlive:", alive);
if (alive) { console.error("FAIL AC-S1: grandchild survived group kill"); process.exit(1); }
console.log("PASS AC-S1");
