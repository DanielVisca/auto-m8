// Mobile: the phone is another screen onto the same conversations, not a second app.
// - Anywhere access: `tailscale serve` gives the Mac an HTTPS name on the tailnet. It proxies to a
//   listener of its own (REMOTE_PORT in remote.ts) that is never treated as the Mac, so every
//   request through it still needs a paired device.
// - Push: when something needs you and you are away from the Mac, the phone gets a notification.
// - Handoff: every screen reports where it is; coming back to the other device offers to continue there.
// - Drafts: what you were typing follows you between devices.
// - Stay awake: the Mac doesn't idle-sleep while agents are running.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import webpush from 'web-push'
import { runningChats } from './chat.ts'
import { needsList } from './needsstore.ts'
import { all, get, run } from './db.ts'
import { deviceFor, isLoopback } from './remote.ts'
import { settings } from './settings.ts'

run(`create table if not exists push_subs (endpoint text primary key, device_id text, sub text not null, created_at integer, last_ok integer, last_error text)`)
run(`create table if not exists mobile_kv (k text primary key, v text)`)
run(`create table if not exists device_presence (device text primary key, name text, view text, title text, at integer)`)
run(`create table if not exists drafts (id text primary key, text text not null, device text, updated_at integer)`)

const kv = (k: string) => get<{ v: string }>('select v from mobile_kv where k = ?', k)?.v
const setKv = (k: string, v: string) => run('insert into mobile_kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v', k, v)

// ---------- who is this request ----------
export function who(req: IncomingMessage) {
  if (isLoopback(req)) return { id: 'mac', name: 'Mac' }
  const d = deviceFor(req)
  return d ? { id: d.id, name: d.name } : { id: 'unknown', name: 'Device' }
}

// ---------- Tailscale ----------
const sh = (cmd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>(r =>
  execFile(cmd, args, { timeout: 15_000 }, (e, out, err) => r({ ok: !e, out: String(out || err || e?.message || '') })))
const TS = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(p => existsSync(p)) ?? 'tailscale'

export const tailscale: { host: string | null; https: boolean; serving: boolean; error?: string } = { host: null, https: false, serving: false }

export async function refreshTailscale() {
  const st = await sh(TS, ['status', '--json'])
  if (!st.ok) { Object.assign(tailscale, { host: null, https: false, serving: false, error: 'Tailscale is not running on this Mac.' }); return tailscale }
  try {
    const j = JSON.parse(st.out)
    tailscale.host = String(j.Self?.DNSName ?? '').replace(/\.$/, '') || null
    tailscale.https = (j.CertDomains ?? []).length > 0
  } catch { tailscale.host = null }
  const serve = await sh(TS, ['serve', 'status', '--json'])
  tailscale.serving = serve.ok && serve.out.includes(`127.0.0.1:${remotePort()}`)
  tailscale.error = !tailscale.https ? 'HTTPS certificates are off for this tailnet (admin console → DNS → HTTPS).' : undefined
  return tailscale
}

export const remotePort = () => Number(process.env.PERCH_PORT ?? settings.port) + 100 // 4877; 4778 is the personal profile
export const tailscaleUrl = () => tailscale.host && tailscale.serving ? `https://${tailscale.host}` : null

// Turns the tailnet address on or off. Off removes only perch's own serve entry.
export async function setTailscale(on: boolean) {
  await refreshTailscale()
  if (!tailscale.host) throw new Error(tailscale.error ?? 'Tailscale is not running on this Mac.')
  const r = on
    ? await sh(TS, ['serve', '--bg', '--https=443', `http://127.0.0.1:${remotePort()}`])
    : await sh(TS, ['serve', '--https=443', 'off'])
  if (!r.ok && on) throw new Error(`tailscale serve failed: ${r.out.trim().slice(0, 200)}`)
  return refreshTailscale()
}

// ---------- push ----------
function vapid() {
  let k = kv('vapid')
  if (!k) { k = JSON.stringify(webpush.generateVAPIDKeys()); setKv('vapid', k) }
  return JSON.parse(k) as { publicKey: string; privateKey: string }
}
export const pushKey = () => vapid().publicKey

export function subscribe(req: IncomingMessage, sub: any) {
  if (!sub?.endpoint || !sub?.keys?.p256dh) throw new Error('Not a push subscription.')
  run(`insert into push_subs (endpoint, device_id, sub, created_at) values (?, ?, ?, ?)
       on conflict(endpoint) do update set device_id = excluded.device_id, sub = excluded.sub, last_error = null`,
    sub.endpoint, who(req).id, JSON.stringify(sub), Date.now())
  return { ok: true }
}
export const unsubscribe = (endpoint: string) => run('delete from push_subs where endpoint = ?', endpoint)
export const pushDevices = () => all<any>('select device_id, created_at, last_ok, last_error from push_subs')

export async function notify(n: { title: string; body: string; url: string; tag?: string }) {
  const { publicKey, privateKey } = vapid()
  webpush.setVapidDetails('mailto:perch@localhost', publicKey, privateKey)
  const subs = all<{ endpoint: string; sub: string }>('select endpoint, sub from push_subs')
  let sent = 0
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(n), { TTL: 3600, urgency: 'high' })
      run('update push_subs set last_ok = ?, last_error = null where endpoint = ?', Date.now(), s.endpoint); sent++
    } catch (e: any) {
      // Gone: the phone dropped the subscription (app removed, permission revoked).
      if (e?.statusCode === 404 || e?.statusCode === 410) unsubscribe(s.endpoint)
      else run('update push_subs set last_error = ? where endpoint = ?', String(e?.body || e?.message).slice(0, 200), s.endpoint)
    }
  }))
  return { sent, of: subs.length }
}

// ---------- away detection ----------
// Away from the Mac: no keyboard or mouse for AWAY_MS (the screen lock counts, it stops input too).
const AWAY_MS = 3 * 60_000
export async function macIdleMs() {
  const r = await sh('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'])
  const m = r.out.match(/"HIDIdleTime"\s*=\s*(\d+)/)
  return m ? Number(m[1]) / 1e6 : 0
}

// ---------- production concerns ----------
// The scorecard (server/proof.ts) says when a merged PR has a concern. Anything touching health or
// the blast radius is urgent (P0: push now, even if you are at the Mac); a weaker concern waits for
// you to be away (P1). Each PR/severity is announced once and remembered across restarts.
type ProofRow = { url: string; state: string; healthy: string; contained: string; works: string; used: string }
export function proofAlerts(rows: ProofRow[], told: Set<string>) {
  const out: { key: string; p: 0 | 1; title: string; body: string; url: string }[] = []
  for (const r of rows) {
    if (r.state !== 'concerns') continue
    const bad = (['healthy', 'contained', 'works', 'used'] as const).filter(k => r[k] === 'concern')
    const p: 0 | 1 = r.healthy === 'concern' || r.contained === 'concern' ? 0 : 1
    const key = `proof:${r.url}:p${p}`
    if (told.has(key)) continue
    const n = r.url.split('/').pop()
    out.push({ key, p, title: p === 0 ? 'Prod concern: act now' : 'Prod concern', body: `PostHog/posthog#${n}: ${bad.join(', ') || 'check'} flagged by the scorecard`, url: r.url })
  }
  return out
}
// P0 concerns that are open right now (the icon's source of truth: it clears when the scorecard stops saying concerns).
export function openProdAlerts() {
  const rows = all<ProofRow & { comment_url: string | null; updated_at: number | null }>(`select p.url, p.state, p.healthy, p.contained, p.works, p.used, p.comment_url, p.updated_at from pr_proof p join shepherd_watch w on w.url = p.url where p.state = 'concerns' and w.merged_at > ?`, Date.now() - 3 * 86400_000)
  return rows.filter(r => r.healthy === 'concern' || r.contained === 'concern').map(r => ({
    url: r.url, comment_url: r.comment_url, since: r.updated_at, reason: (['healthy', 'contained'] as const).filter(k => r[k] === 'concern').join(' + ') + ' flagged',
  }))
}
export async function proofTick(away: boolean) {
  const told = new Set<string>(JSON.parse(kv('proof_alerted') ?? '[]'))
  const rows = all<ProofRow>(`select p.url, p.state, p.healthy, p.contained, p.works, p.used from pr_proof p join shepherd_watch w on w.url = p.url where p.state = 'concerns' and w.merged_at > ?`, Date.now() - 3 * 86400_000)
  if (kv('proof_alerted') === undefined) { // first run: learn what's already flagged instead of pushing a backlog
    proofAlerts(rows, told).forEach(a => told.add(a.key)); setKv('proof_alerted', JSON.stringify([...told])); return 0
  }
  const due = proofAlerts(rows, told).filter(a => a.p === 0) // P1 stays on the PR comment: only high-confidence P0 interrupts
  if (!due.length || settings.mobile?.push === false) return 0
  let sent = 0
  for (const a of due) {
    const r = await notify({ title: a.title, body: a.body, url: a.url, tag: a.key })
    if (r.sent) { sent += r.sent; told.add(a.key) }
  }
  setKv('proof_alerted', JSON.stringify([...told].slice(-300)))
  return sent
}

// ---------- the notifier ----------
// Something new needs you (an agent asked, a decision opened) and you're away from the Mac: push it.
// Every item is announced once; the phone hides it if perch is already open in front of you.
let seen: Set<string> | null = null
export async function notifyTick(onAway?: (away: boolean) => void) {
  const items = needsList().items.filter(n => n.status === 'needs_you').map(n => ({
    key: `need:${n.id}:${n.revision}`, title: 'Needs you', body: String(n.human_action || n.title).slice(0, 140), url: '/#needs', tag: `need:${n.id}`,
  }))
  const fresh = seen ? items.filter(i => !seen!.has(i.key)) : [] // the first pass only learns what's already there
  seen = new Set(items.map(i => i.key))
  const away = (await macIdleMs()) > AWAY_MS
  onAway?.(away)
  proofTick(away).catch(e => console.error('[proof-alert]', e?.message))
  if (!fresh.length || !away || settings.mobile?.push === false) return { fresh: fresh.length, away, sent: 0 }
  const one = fresh.length === 1 ? fresh[0] : { title: `${fresh.length} things need you`, body: fresh.map(f => f.body).join(' · ').slice(0, 180), url: '/#home', tag: 'perch-batch' }
  const r = await notify(one)
  return { fresh: fresh.length, away, sent: r.sent }
}

// ---------- presence and handoff ----------
export function beat(req: IncomingMessage, view: string, title: string) {
  const w = who(req)
  const chat = String(view ?? '').match(/^#chat\/(.+)$/)
  if (chat && !title) title = get<{ t: string }>(`select coalesce(u.title, c.title, c.first_prompt, '') as t from conversations c left join user_state u on u.id = c.id where c.id = ?`, decodeURIComponent(chat[1]))?.t ?? ''
  run(`insert into device_presence (device, name, view, title, at) values (?, ?, ?, ?, ?)
       on conflict(device) do update set name = excluded.name, view = excluded.view, title = excluded.title, at = excluded.at`, w.id, w.name, String(view ?? '').slice(0, 300), String(title ?? '').slice(0, 140), Date.now())
}
// Where you were last on any other device, if that is newer than this device's own last moment.
export function handoff(req: IncomingMessage) {
  const me = who(req).id
  const mine = get<{ at: number }>('select at from device_presence where device = ?', me)?.at ?? 0
  // Only devices that are still paired (or the Mac): a revoked phone's last screen isn't offered.
  const other = get<any>(`select device, name, view, title, at from device_presence where device != ? and (device = 'mac' or device in (select id from devices)) order by at desc limit 1`, me)
  if (!other || other.at <= mine || Date.now() - other.at > 6 * 3600_000) return null
  return other
}

// ---------- drafts ----------
export const getDraft = (id: string) => get<{ text: string; updated_at: number; device: string }>('select text, updated_at, device from drafts where id = ?', id) ?? null
export function putDraft(req: IncomingMessage, id: string, text: string) {
  if (!text) run('delete from drafts where id = ?', id)
  else run(`insert into drafts (id, text, device, updated_at) values (?, ?, ?, ?)
            on conflict(id) do update set text = excluded.text, device = excluded.device, updated_at = excluded.updated_at`, id, String(text).slice(0, 20000), who(req).id, Date.now())
  return { ok: true }
}

// ---------- stay awake while agents run ----------
// caffeinate -i: no idle sleep; -s: no system sleep on AC power. It dies with perch (-w).
let caff: ChildProcess | null = null
export const awake = () => !!caff
export function stayAwakeTick() {
  const want = settings.mobile?.stayAwake !== false && runningChats().some(c => c.state === 'running')
  if (want && !caff) {
    caff = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
    caff.on('exit', () => { caff = null })
  } else if (!want && caff) { caff.kill(); caff = null }
}

export function mobileStatus() {
  return { tailscale: { ...tailscale, url: tailscaleUrl() }, push: { key: pushKey(), devices: pushDevices() }, awake: awake(), settings: settings.mobile }
}
