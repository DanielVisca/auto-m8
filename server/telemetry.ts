// Anonymous usage stats, so we can see whether new users get to a working chat and which parts
// they use. Opt-out on fresh installs (the first setup screen and Settings both say so), off for
// installs that predate it, and never on with DO_NOT_TRACK=1 or without a project key.
//
// What leaves the Mac: an event name from EVENTS, a random install id, the app version, macOS
// version and CPU arch, and only the properties EVENTS lists for that event. Every property value
// is a number, a boolean or a short slug (a step or feature name, an error code). No text, no
// prompts, no code, no repo names, no paths: sanitize() drops anything that doesn't fit, and
// telemetry.test.ts checks it.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, release } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR, UNDER_TEST, settings } from './settings.ts'

// The PostHog project key. Left empty on purpose: with no key (here, in Settings or in
// AUTO_M8_TELEMETRY_KEY) nothing is sent at all.
export const TELEMETRY_KEY = ''
const DEFAULT_HOST = 'https://us.i.posthog.com'

type Kind = 'slug' | 'number' | 'bool'
// Every event auto-m8 can send, and the only properties each may carry.
export const EVENTS: Record<string, Record<string, Kind>> = {
  app_first_open: {},
  setup_step_completed: { step: 'slug', seconds_since_first_open: 'number' },
  setup_step_failed: { step: 'slug', reason_code: 'slug' },
  onboarding_completed: { seconds: 'number' },
  chat_started: { engine: 'slug' },
  feature_used: { feature: 'slug' },
  connection_added: { kind: 'slug' },
  suggestion_shown: { kind: 'slug' },
  suggestion_acted: { kind: 'slug' },
  suggestion_dismissed: { kind: 'slug' },
  pr_opened_by_agent: {},
  pr_merged_via_shepherd: {},
  server_stall: { reason_code: 'slug' },
  daily_active: {},
}
// The surfaces feature_used counts. Anything else is dropped.
export const FEATURES = ['search', 'needs_me', 'shepherd', 'delegate', 'race', 'browser', 'routines', 'boards'] as const

const SLUG = /^[a-z0-9][a-z0-9_.:-]{0,39}$/i
const fits = (kind: Kind, v: unknown) =>
  kind === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : kind === 'bool' ? typeof v === 'boolean'
  : typeof v === 'string' && SLUG.test(v)

const VERSION = (() => { try { return JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version as string } catch { return '0.0.0' } })()
// Fixed for every event: who (a random id), and which build on which OS.
export const baseProps = () => ({ distinct_id: installId(), $app_version: VERSION, $os: 'macOS', $os_version: release(), arch: arch(), $lib: 'auto-m8', $process_person_profile: false })

// The event as it would be sent, or null when it isn't one we send. Unknown properties and
// values that aren't a number, boolean or short slug are dropped.
export function sanitize(event: string, props: Record<string, unknown> = {}): { event: string; properties: Record<string, unknown> } | null {
  const allowed = EVENTS[event]
  if (!allowed) return null
  const out: Record<string, unknown> = {}
  for (const [k, kind] of Object.entries(allowed)) if (fits(kind, props[k])) out[k] = kind === 'number' ? Math.round(props[k] as number) : props[k]
  if (event === 'feature_used' && !(FEATURES as readonly string[]).includes(String(out.feature))) return null
  return { event, properties: { ...out, ...baseProps() } }
}

let id: string | undefined
export function installId(): string {
  if (id) return id
  const f = join(DATA_DIR, 'install-id')
  try { id = readFileSync(f, 'utf8').trim() } catch {}
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) { id = randomUUID(); try { writeFileSync(f, id) } catch {} }
  return id
}

export const telemetryKey = () => settings.telemetry?.key?.trim() || process.env.AUTO_M8_TELEMETRY_KEY?.trim() || TELEMETRY_KEY
const doNotTrack = () => /^(1|true|yes)$/i.test(process.env.DO_NOT_TRACK ?? '')
// Why it's on or off, for Settings.
export function telemetryState(): { enabled: boolean; sending: boolean; reason?: string } {
  const enabled = !!settings.telemetry?.enabled
  if (doNotTrack()) return { enabled, sending: false, reason: 'DO_NOT_TRACK is set' }
  if (!enabled) return { enabled, sending: false }
  if (!telemetryKey()) return { enabled, sending: false, reason: 'no project key configured, so nothing is sent' }
  return { enabled, sending: true }
}

let queue: { event: string; properties: Record<string, unknown>; timestamp: string }[] = []
let timer: NodeJS.Timeout | undefined
// Sent records what would have gone out, for the test and for Settings → "show what's sent".
export const recent: { event: string; properties: Record<string, unknown>; at: number }[] = []

export function track(event: string, props: Record<string, unknown> = {}) {
  const e = sanitize(event, props)
  if (!e) return
  recent.push({ ...e, at: Date.now() }); if (recent.length > 50) recent.shift()
  if (UNDER_TEST || !telemetryState().sending) return
  queue.push({ ...e, timestamp: new Date().toISOString() })
  if (queue.length > 500) queue = queue.slice(-500)
  timer ??= setTimeout(flush, 10_000)
  timer.unref?.()
}

export async function flush() {
  timer = undefined
  const batch = queue; queue = []
  const key = telemetryKey()
  if (!batch.length || !key || !telemetryState().sending) return
  const host = (settings.telemetry?.host || process.env.AUTO_M8_TELEMETRY_HOST || DEFAULT_HOST).replace(/\/+$/, '')
  try {
    await fetch(`${host}/batch/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key, batch }), signal: AbortSignal.timeout(10_000) })
  } catch {} // best effort: a lost batch is fine
}

// One ping per local day the server runs.
function dailyPing() {
  const f = join(DATA_DIR, 'telemetry-day'), day = new Date().toLocaleDateString('sv')
  let last = ''
  try { last = readFileSync(f, 'utf8').trim() } catch {}
  if (last === day) return
  track('daily_active')
  try { writeFileSync(f, day) } catch {}
}
export function startTelemetry() {
  if (UNDER_TEST) return
  setTimeout(dailyPing, 30_000).unref?.()
  setInterval(dailyPing, 3600_000).unref?.()
}

// Seconds since the first open of this install (for setup step timings).
export function firstOpenAt(): number | null {
  const f = join(DATA_DIR, 'first-open')
  try { return Number(readFileSync(f, 'utf8')) || null } catch { return null }
}
// Marks the first open once, on a fresh install, and sends app_first_open.
export function markFirstOpen() {
  const f = join(DATA_DIR, 'first-open')
  if (existsSync(f)) return
  try { writeFileSync(f, String(Date.now())) } catch {}
  track('app_first_open')
}
export const secondsSinceFirstOpen = () => { const t = firstOpenAt(); return t ? (Date.now() - t) / 1000 : 0 }
