// Explicit status signals from Claude Code hooks (Notification, Stop, PreToolUse,
// UserPromptSubmit). Read first; transcript heuristics and the AI attention
// sweep remain the fallback when a signal is missing, stale, or superseded.

export type HookStatus = "running" | "waiting_permission" | "needs_you" | "done";

export type HookSignal = {
  sessionId: string;
  event: string;
  status: HookStatus;
  at: number;
  cwd?: string;
  transcriptPath?: string;
  tool?: string;
  message?: string;
};

// A tool can hang without another hook firing; past this, stop trusting "running".
const RUNNING_STALE_MS = 30 * 60_000;

export function statusFromEvent(p: { hook_event_name?: string; message?: string; tool_name?: string }): HookStatus | undefined {
  switch (p.hook_event_name) {
    case "UserPromptSubmit":
    case "PreToolUse":
      return "running";
    case "Notification":
      return /permission/i.test(p.message ?? "") ? "waiting_permission" : "needs_you";
    case "Stop":
      return "done";
    default:
      return undefined;
  }
}

export function parseHookPayload(raw: unknown, now = Date.now()): HookSignal | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const sessionId = str("session_id");
  const event = str("hook_event_name");
  if (!sessionId || !event) return undefined;
  const status = statusFromEvent({ hook_event_name: event, message: str("message") });
  if (!status) return undefined;
  return {
    sessionId,
    event,
    status,
    at: now,
    cwd: str("cwd"),
    transcriptPath: str("transcript_path"),
    tool: str("tool_name"),
    message: str("message")?.slice(0, 300),
  };
}

export class HookSignalStore {
  private latest = new Map<string, HookSignal>();

  record(raw: unknown, now = Date.now()): HookSignal | undefined {
    const signal = parseHookPayload(raw, now);
    if (signal) {
      this.latest.delete(signal.sessionId); // re-insert so the map stays in arrival order
      this.latest.set(signal.sessionId, signal);
      // Every claude process fires these, perch's own background jobs included: keep the newest few thousand.
      if (this.latest.size > 5000) this.latest.delete(this.latest.keys().next().value!);
    }
    return signal;
  }

  get(sessionId: string): HookSignal | undefined {
    return this.latest.get(sessionId);
  }

  // undefined means "no trustworthy signal: use the transcript heuristics".
  statusFor(sessionId: string, opts: { now?: number; transcriptMtime?: number } = {}): HookStatus | undefined {
    const s = this.latest.get(sessionId);
    if (!s) return undefined;
    const now = opts.now ?? Date.now();
    if (opts.transcriptMtime !== undefined && opts.transcriptMtime > s.at) return undefined;
    if (s.status === "running" && now - s.at > RUNNING_STALE_MS) return undefined;
    return s.status;
  }
}

// The one store the server records into and the list reads from. In memory: after a restart the
// transcript heuristics cover until the next hook fires.
export const hookSignals = new HookSignalStore();
