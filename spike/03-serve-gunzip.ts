// AC-S3: Bun.serve + gunzip round-trips a gzipped body unchanged, returns 200.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("content-encoding") === "gzip") {
      const body = Bun.gunzipSync(new Uint8Array(await req.arrayBuffer()));
      return new Response(new TextDecoder().decode(body), { status: 200 });
    }
    return new Response("no-encoding", { status: 400 });
  },
});
const payload = "round-trip-marker";
const res = await fetch(`http://localhost:${server.port}/`, {
  method: "POST",
  headers: { "content-encoding": "gzip" },
  body: Bun.gzipSync(new TextEncoder().encode(payload)),
});
const text = await res.text();
server.stop();
console.log("status:", res.status, "body:", text);
if (res.status !== 200 || text !== payload) { console.error("FAIL AC-S3"); process.exit(1); }
console.log("PASS AC-S3");
