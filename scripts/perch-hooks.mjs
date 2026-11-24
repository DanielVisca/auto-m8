#!/usr/bin/env node
// Adds or removes perch's status hooks in ~/.claude/settings.json.
//   node scripts/perch-hooks.mjs install | uninstall | status
// install backs up settings.json first; uninstall removes only perch's entries.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EVENTS = ["Notification", "Stop", "PreToolUse", "UserPromptSubmit"];
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const cmd = args[0];
const settingsPath = resolve(flag("--settings", join(homedir(), ".claude", "settings.json")));
const hookPath = resolve(flag("--hook", join(import.meta.dirname, "perch-hook.sh")));
const isPerch = (h) => typeof h?.command === "string" && h.command.endsWith("perch-hook.sh");

const read = () => (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {});
const write = (s) => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
};
const installed = (s) => EVENTS.every((ev) => (s.hooks?.[ev] ?? []).some((m) => m.hooks?.some(isPerch)));

function strip(s) {
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    s.hooks[ev] = s.hooks[ev]
      .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isPerch(h)) }))
      .filter((m) => m.hooks.length > 0);
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return s;
}

const s = read();
if (cmd === "install") {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.perch-backup-${Date.now()}`);
  if (existsSync(hookPath)) chmodSync(hookPath, 0o755);
  strip(s);
  s.hooks ??= {};
  for (const ev of EVENTS) {
    (s.hooks[ev] ??= []).push({ matcher: "", hooks: [{ type: "command", command: hookPath, timeout: 5 }] });
  }
  write(s);
  console.log(`auto-m8 hooks installed in ${settingsPath} (${EVENTS.join(", ")}). Undo: node ${process.argv[1]} uninstall`);
} else if (cmd === "uninstall") {
  write(strip(s));
  console.log(`auto-m8 hooks removed from ${settingsPath}`);
} else if (cmd === "status") {
  console.log(installed(s) ? `installed in ${settingsPath}` : `not installed in ${settingsPath}`);
} else {
  console.error("usage: perch-hooks.mjs install|uninstall|status [--settings path] [--hook path]");
  process.exit(2);
}
