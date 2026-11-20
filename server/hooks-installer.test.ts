import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const installer = join(import.meta.dirname, "../scripts/perch-hooks.mjs");
const run = (settings: string, ...args: string[]) =>
  execFileSync("node", [installer, ...args, "--settings", settings, "--hook", "/opt/perch/scripts/perch-hook.sh"], { encoding: "utf8" });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "perch-hooks-"));
  const settings = join(dir, "settings.json");
  const original = {
    model: "opus",
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }] },
  };
  writeFileSync(settings, JSON.stringify(original, null, 2));
  return { dir, settings, original };
}

test("install adds perch hooks for each event, keeps existing ones, and backs up", () => {
  const { dir, settings } = fixture();
  run(settings, "install");
  const s = JSON.parse(readFileSync(settings, "utf8"));
  for (const ev of ["Notification", "Stop", "PreToolUse", "UserPromptSubmit"]) {
    const cmds = s.hooks[ev].flatMap((m: any) => m.hooks.map((h: any) => h.command));
    assert.ok(cmds.includes("/opt/perch/scripts/perch-hook.sh"), ev);
  }
  assert.ok(s.hooks.Stop.some((m: any) => m.hooks[0].command === "say done"));
  assert.equal(s.model, "opus");
  assert.ok(readdirSync(dir).some((f) => f.startsWith("settings.json.perch-backup-")));
});

test("install is idempotent", () => {
  const { settings } = fixture();
  run(settings, "install");
  run(settings, "install");
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.Stop.length, 2);
});

test("uninstall restores the original settings exactly", () => {
  const { settings, original } = fixture();
  run(settings, "install");
  run(settings, "uninstall");
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), original);
});

test("install works when settings.json does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-hooks-"));
  const settings = join(dir, "settings.json");
  run(settings, "install");
  assert.ok(JSON.parse(readFileSync(settings, "utf8")).hooks.Notification);
  run(settings, "uninstall");
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), {});
});

test("status reports whether hooks are installed", () => {
  const { settings } = fixture();
  assert.match(run(settings, "status"), /not installed/);
  run(settings, "install");
  assert.match(run(settings, "status"), /^installed/);
});
