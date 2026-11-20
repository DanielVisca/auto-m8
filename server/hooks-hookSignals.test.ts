import { test } from "node:test";
import assert from "node:assert/strict";
import { HookSignalStore, parseHookPayload, statusFromEvent } from "./hookSignals.ts";

test("maps Claude Code hook events to statuses", () => {
  assert.equal(statusFromEvent({ hook_event_name: "UserPromptSubmit" }), "running");
  assert.equal(statusFromEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" }), "running");
  assert.equal(statusFromEvent({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }), "waiting_permission");
  assert.equal(statusFromEvent({ hook_event_name: "Notification", message: "Claude is waiting for your input" }), "needs_you");
  assert.equal(statusFromEvent({ hook_event_name: "Stop" }), "done");
  assert.equal(statusFromEvent({ hook_event_name: "SessionStart" }), undefined);
});

test("parse rejects payloads without a session id or event", () => {
  assert.equal(parseHookPayload({ hook_event_name: "Stop" }), undefined);
  assert.equal(parseHookPayload({ session_id: "s1" }), undefined);
  assert.equal(parseHookPayload("nope"), undefined);
});

test("parse keeps only small fields and drops tool_input", () => {
  const s = parseHookPayload({
    session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { content: "x".repeat(10_000) }, cwd: "/repo", transcript_path: "/t.jsonl",
  }, 1000);
  assert.deepEqual(s, { sessionId: "s1", event: "PreToolUse", status: "running", at: 1000, cwd: "/repo", transcriptPath: "/t.jsonl", tool: "Write", message: undefined });
});

test("store keeps the latest signal per session", () => {
  const store = new HookSignalStore();
  store.record({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" }, 1000);
  store.record({ session_id: "s1", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }, 2000);
  store.record({ session_id: "s2", hook_event_name: "Stop" }, 1500);
  assert.equal(store.get("s1")?.status, "waiting_permission");
  assert.equal(store.get("s2")?.status, "done");
});

test("hook status defers to transcript heuristics when the transcript moved after the signal", () => {
  const store = new HookSignalStore();
  store.record({ session_id: "s1", hook_event_name: "Stop" }, 1000);
  assert.equal(store.statusFor("s1", { now: 2000, transcriptMtime: 900 }), "done");
  assert.equal(store.statusFor("s1", { now: 2000, transcriptMtime: 5000 }), undefined);
  assert.equal(store.statusFor("missing", { now: 2000 }), undefined);
});

test("a running signal goes stale so a hung tool falls back to heuristics and the AI sweep", () => {
  const store = new HookSignalStore();
  store.record({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" }, 0);
  assert.equal(store.statusFor("s1", { now: 60_000 }), "running");
  assert.equal(store.statusFor("s1", { now: 31 * 60_000 }), undefined);
});
