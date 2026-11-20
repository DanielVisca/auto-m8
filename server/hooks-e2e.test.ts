import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { HookSignalStore } from "./hookSignals.ts";
import { handleHookPost } from "./hookRoute.ts";

const hook = join(import.meta.dirname, "../scripts/perch-hook.sh");

test("hook script posts real hook stdin to the perch endpoint, and never fails the hook", async () => {
  const store = new HookSignalStore();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = req.url === "/api/hooks/claude" && req.method === "POST"
        ? handleHookPost(store, body) : { status: 404, json: {} };
      res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  // async so the in-process server can answer while the hook runs
  const fire = (payload: object, env: Record<string, string> = { PERCH_URL: url }) =>
    new Promise<{ code: number; out: string }>((done) => {
      const child = execFile("bash", [hook], { env: { ...process.env, ...env, PERCH_HOOK_SYNC: "1" } }, (err, out) =>
        done({ code: err ? Number((err as any).code) : 0, out }));
      child.stdin!.end(JSON.stringify(payload));
    });

  await fire({ session_id: "abc", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/r" });
  assert.equal(store.get("abc")?.status, "running");
  await fire({ session_id: "abc", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
  assert.equal(store.get("abc")?.status, "waiting_permission");
  await fire({ session_id: "abc", hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(store.get("abc")?.status, "done");

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  // perch not running: hook must still exit 0 with no output so Claude Code is never blocked
  const down = await fire({ session_id: "abc", hook_event_name: "Stop" }, { PERCH_URL: "http://127.0.0.1:1" });
  assert.deepEqual(down, { code: 0, out: "" });
});

test("route rejects junk with 400", () => {
  const store = new HookSignalStore();
  assert.equal(handleHookPost(store, "not json").status, 400);
  assert.equal(handleHookPost(store, "{}").status, 400);
});
