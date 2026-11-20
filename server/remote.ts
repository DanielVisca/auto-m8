// Phone access over the local network. perch can run commands, so a device on the wifi gets
// nothing until it is paired: you show a QR code on the Mac, the phone opens it, and gets its
// own long-lived token in an HttpOnly cookie. Tokens are stored hashed and can be revoked.
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import { all, db, get, run } from './db.ts'

db.exec(`create table if not exists devices (
  id text primary key, name text, token_hash text not null unique, created_at integer, last_seen integer, last_ip text
)`)

const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const COOKIE = 'perch_device'
const pairing = new Map<string, number>() // one-time code -> expiry

// The Mac's addresses a phone could use: its LAN IPv4s and its Bonjour name.
export function lanHosts(port: number) {
  const ips = Object.values(networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map(a => a!.address)
  const local = hostname().replace(/\.local$/, '') + '.local'
  return { ips, hosts: [...ips, local].map(h => `${h}:${port}`) }
}

// The tailnet listener (tailscale serve proxies to it from 127.0.0.1) is never the Mac itself.
let remoteOnly = -1
export const setRemoteOnlyPort = (p: number) => { remoteOnly = p }
// The phone's address: through the tailnet proxy it is in X-Forwarded-For.
const peer = (req: IncomingMessage) => (req.socket.localPort === remoteOnly ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || null
export const isLoopback = (req: IncomingMessage) => {
  if (req.socket.localPort === remoteOnly) return false
  const a = req.socket.localAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function cookie(req: IncomingMessage, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function deviceFor(req: IncomingMessage) {
  const token = cookie(req, COOKIE)
  if (!token) return null
  const d = get<{ id: string; name: string }>('select id, name from devices where token_hash = ?', hash(token))
  if (d) run('update devices set last_seen = ?, last_ip = ? where id = ?', Date.now(), peer(req), d.id)
  return d ?? null
}

// base: the tailnet's https address when it is on (works anywhere), else the wifi address.
export async function startPairing(port: number, base?: string | null) {
  const code = randomBytes(9).toString('base64url')
  pairing.set(code, Date.now() + 10 * 60_000)
  const { ips } = lanHosts(port)
  const url = `${base ?? `http://${ips[0] ?? hostname()}:${port}`}/pair?code=${code}`
  return { url, code, qr: await QRCode.toString(url, { type: 'svg', margin: 1 }), expiresInMinutes: 10 }
}

// Exchanges a one-time code for a device token. Returns the Set-Cookie value, or null.
export function completePairing(code: string, req: IncomingMessage) {
  const exp = pairing.get(code)
  pairing.delete(code)
  if (!exp || exp < Date.now()) return null
  const token = randomBytes(32).toString('base64url')
  const ua = String(req.headers['user-agent'] ?? '')
  const name = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : 'Device'
  run('insert into devices (id, name, token_hash, created_at, last_seen, last_ip) values (?, ?, ?, ?, ?, ?)',
    randomBytes(6).toString('hex'), name, hash(token), Date.now(), Date.now(), peer(req))
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${365 * 86400}`
}

export const listDevices = () => all('select id, name, created_at, last_seen, last_ip from devices order by last_seen desc')
export const revokeDevice = (id: string) => run('delete from devices where id = ?', id)

export const UNPAIRED_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>perch</title><body style="font:16px -apple-system,system-ui;padding:32px;max-width:420px;margin:auto;color:#444">
<h2>perch</h2><p>This device isn't paired.</p><p>On your Mac, open perch → Settings → Phone access → <b>Pair a phone</b>, then scan the code with this phone's camera.</p></body>`
