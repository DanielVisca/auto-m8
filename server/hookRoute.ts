import type { HookSignalStore } from "./hookSignals.ts";

// POST /api/hooks/claude — body is the raw hook stdin JSON from scripts/perch-hook.sh.
export function handleHookPost(store: HookSignalStore, body: string): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, json: { error: "invalid json" } };
  }
  const signal = store.record(parsed);
  if (!signal) return { status: 400, json: { error: "missing session_id or unsupported hook_event_name" } };
  return { status: 200, json: { ok: true, status: signal.status } };
}
