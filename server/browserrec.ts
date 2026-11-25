// Session recordings for the agent browser. Every run dir (<REC_DIR>/<start>-<owner>) gets, cheaply and always:
//   actions.jsonl  every step (written by browser.ts, password values masked)
//   network.jsonl  method/url/status/mime/type of XHR, Fetch and Document requests (no headers, bodies or cookies)
//   meta.json      owner, goal(s), start/end, urls, step count, outcome
// and, when settings.browser.recordVisual is on or the agent opened with mode=visual (Session.record):
//   rrweb.jsonl.gz the DOM recording (rrweb, every input masked), replayable in /api/browser/recordings/:id/replay
//   video.webm     screencast frames stitched by ffmpeg when a goal finishes or the window closes (if ffmpeg exists)
//
// rrweb runs in perch's isolated world and perch drains its queue by polling, so the page sees no globals and
// we never call Runtime.enable (a bot-detection signal). Hosts on the deny list are never recorded, and frames
// aren't captured while a password or card field has focus.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setPriority } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import * as B from './browser.ts'
import { settings } from './settings.ts'

const FRAME_MIN_MS = 200 // at most ~5 frames a second go to disk
const RR_FLUSH_BYTES = 256_000
const NET_TYPES = new Set(['XHR', 'Fetch', 'Document'])

export const FFMPEG = process.env.PERCH_FFMPEG ?? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => existsSync(p)) ?? null

type Meta = { owner: string; goal: string | null; goals: { goal: string; ok: boolean; at: number }[]; start: number; end: number | null; urls: string[]; steps: number; outcome: 'ok' | 'failed' | null; visual: boolean }
type Rec = {
  s: B.Session; meta: Meta; netSeen: Set<string>
  visual: boolean; visualStarting: Promise<void> | null; scriptId: string | null; stopFrames: (() => Promise<void>) | null; poll: NodeJS.Timeout | null; draining: boolean
  rrBuf: string[]; rrBytes: number; rrTimer: NodeJS.Timeout | null
  frames: { file: string; t: number }[]; frameN: number; lastFrameAt: number; sensitive: boolean
}

const recs = new Map<B.Session, Rec>()
const pending = new Set<Promise<unknown>>()
const track = <T>(p: Promise<T>) => { pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p }

// ---------- the in-page recorder ----------
const req = createRequire(import.meta.url)
function asset(pkg: string, candidates: string[], fallback: RegExp): string | null {
  let root = ''
  try { root = dirname(req.resolve(`${pkg}/package.json`)) } catch { return null }
  for (const c of candidates) if (existsSync(join(root, c))) return join(root, c)
  const walk = (d: string): string | null => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) { const r = walk(p); if (r) return r } else if (fallback.test(f.name)) return p
    }
    return null
  }
  try { return walk(join(root, 'dist')) } catch { return null }
}
let recordScript: string | null | undefined
export function pageRecorder(): string | null {
  if (recordScript !== undefined) return recordScript
  const file = asset('rrweb', ['dist/record/rrweb-record.min.js', 'dist/record/rrweb-record.js', 'dist/record/rrweb-record.umd.min.cjs', 'dist/rrweb.min.js', 'dist/rrweb.umd.min.cjs', 'dist/rrweb.umd.cjs', 'dist/rrweb.js'], /^rrweb.*\.(min\.)?c?js$/)
  if (!file) { console.error('browserrec: rrweb not installed (npm i rrweb@2.0.0-alpha.4); DOM recording is off'); return (recordScript = null) }
  const lib = readFileSync(file, 'utf8')
  // The UMD/IIFE build is wrapped so it defines nothing on the world's global object.
  recordScript = `(function(){
if (window !== window.top || globalThis.__perchRecOn) return; globalThis.__perchRecOn = true;
var module = { exports: {} }, exports = module.exports, define = undefined;
${lib}
;var R = (typeof rrwebRecord !== 'undefined' && rrwebRecord) || (typeof rrweb !== 'undefined' && rrweb) || module.exports;
var record = typeof R === 'function' ? R : (R.record || (R.default && (R.default.record || R.default)));
var buf = [], timer = null, stop = null;
var Q = globalThis.__perchRecQ = [];
function send(o) { Q.push(o); if (Q.length > 3000) Q.splice(0, Q.length - 3000) }
function flush() { if (timer) { clearTimeout(timer); timer = null } if (!buf.length) return; var ev = buf; buf = []; send({ t: 'ev', href: location.href, ev: ev }) }
globalThis.__perchRecFlush = flush;
// perch drains the queue by polling this world (no CDP binding: those need Runtime.enable)
globalThis.__perchRecDrain = function () { flush(); return JSON.stringify(Q.splice(0)) };
function sensitive(el) {
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
  var t = String(el.type || '').toLowerCase(), ac = String(el.autocomplete || '').toLowerCase(), n = (String(el.name || '') + ' ' + String(el.id || '')).toLowerCase();
  return t === 'password' || /^cc-|one-time-code/.test(ac) || /card.?num|cc.?num|cvc|cvv|iban|security.?code/.test(n);
}
var last = null;
function focus() { var v = sensitive(document.activeElement); if (v !== last) { last = v; send({ t: 'focus', sensitive: v }) } }
document.addEventListener('focusin', focus, true);
document.addEventListener('focusout', function () { setTimeout(focus, 0) }, true);
addEventListener('pagehide', flush, true);
document.addEventListener('visibilitychange', flush, true);
function start() {
  if (typeof record !== 'function') { send({ t: 'error', error: 'rrweb record() not found in bundle' }); return }
  stop = record({
    emit: function (e) { buf.push(e); if (!timer) timer = setTimeout(flush, 400) },
    maskAllInputs: true,
    // alpha.4 leaves values already in inputs unmasked in the full snapshot unless a mask function is set
    maskInputFn: function (text) { return String(text || '').replace(/./g, '*') },
    maskInputOptions: { password: true, email: true, tel: true, text: true, textarea: true, number: true, search: true, url: true, select: true, color: true, date: true, 'datetime-local': true, month: true, range: true, time: true, week: true },
    maskTextSelector: '[autocomplete^="cc-"], [data-private], [data-perch-mask]',
    sampling: { mousemove: 100, scroll: 150, input: 'last' },
    recordCanvas: false, collectFonts: false, inlineImages: false,
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})()`
  return recordScript
}

// ---------- files ----------
const metaPath = (r: Rec) => join(r.s.runDir, 'meta.json')
function writeMeta(r: Rec) { try { writeFileSync(metaPath(r), JSON.stringify(r.meta, null, 1)) } catch {} }
function loadMeta(s: B.Session): Meta {
  try {
    const m = JSON.parse(readFileSync(join(s.runDir, 'meta.json'), 'utf8'))
    if (m && m.owner) return { ...m, end: null }
  } catch {}
  return { owner: s.owner, goal: s.goal ?? null, goals: [], start: s.created, end: null, urls: [], steps: 0, outcome: null, visual: false }
}

function flushNet(r: Rec) {
  const lines: string[] = []
  for (const n of r.s.net) {
    if (n.status == null || r.netSeen.has(n.id + n.url) || !NET_TYPES.has(n.type)) continue
    if (B.policyFor(n.url) === 'deny') continue
    r.netSeen.add(n.id + n.url)
    lines.push(JSON.stringify({ at: n.at, method: n.method, url: n.url, status: n.status, mime: n.mime ?? '', type: n.type }))
  }
  if (r.netSeen.size > 2000) { const live = new Set(r.s.net.map(n => n.id + n.url)); for (const k of r.netSeen) if (!live.has(k)) r.netSeen.delete(k) }
  if (lines.length) try { appendFileSync(join(r.s.runDir, 'network.jsonl'), lines.join('\n') + '\n') } catch {}
}

function flushRr(r: Rec) {
  if (r.rrTimer) { clearTimeout(r.rrTimer); r.rrTimer = null }
  if (!r.rrBuf.length) return
  const text = r.rrBuf.join('\n') + '\n'
  r.rrBuf = []; r.rrBytes = 0
  // each flush is one gzip member; concatenated members are a valid gzip file
  try { appendFileSync(join(r.s.runDir, 'rrweb.jsonl.gz'), gzipSync(text)) } catch {}
}

function noteUrl(r: Rec) {
  const u = r.s.url
  if (!u || u === 'about:blank' || B.policyFor(u) === 'deny') return
  if (r.meta.urls.at(-1) !== u && r.meta.urls.length < 500) r.meta.urls.push(u)
}

// ---------- visual: rrweb + frames ----------
function onPageMsg(r: Rec, msg: any) {
  if (msg.t === 'focus') { r.sensitive = !!msg.sensitive; return }
  if (msg.t === 'error') { console.error('browserrec page:', msg.error); return }
  if (msg.t !== 'ev' || !Array.isArray(msg.ev)) return
  if (B.policyFor(String(msg.href ?? r.s.url)) === 'deny') return
  for (const e of msg.ev) { const line = JSON.stringify(e); r.rrBuf.push(line); r.rrBytes += line.length }
  if (r.rrBytes > RR_FLUSH_BYTES) flushRr(r)
  else if (!r.rrTimer) r.rrTimer = setTimeout(() => flushRr(r), 3000)
}

// Pull what the page recorded. The recorder lives in perch's isolated world; a new document has a
// fresh world without it, so it's injected again here (rrweb starts with a full snapshot).
async function drain(r: Rec) {
  if (r.draining || !r.visual) return
  r.draining = true
  try {
    if (B.policyFor(r.s.url) === 'deny' || !/^https?:|^data:|^file:/.test(r.s.url)) return
    const q = await B.evalIn(r.s, 'globalThis.__perchRecDrain ? __perchRecDrain() : null', { timeoutMs: 5000 })
    if (q == null) { const script = pageRecorder(); if (script) await B.evalIn(r.s, script, { timeoutMs: 10_000 }); return }
    for (const m of JSON.parse(q)) onPageMsg(r, m)
  } catch {} finally { r.draining = false }
}

const wantsVisual = (s: B.Session) => !!s.record || settings.browser.recordVisual

async function startVisual(r: Rec) {
  const s = r.s
  r.visual = true
  r.meta.visual = true
  writeMeta(r)
  await drain(r)
  r.poll = setInterval(() => { drain(r) }, 500)
  r.poll.unref?.()
  mkdirSync(join(s.runDir, 'frames'), { recursive: true })
  r.stopFrames = await B.watchFrames(s.owner, (data, m) => {
    if (!r.visual || r.sensitive || B.policyFor(s.url) === 'deny') return
    const t = typeof m?.timestamp === 'number' ? m.timestamp * 1000 : Date.now()
    if (t - r.lastFrameAt < FRAME_MIN_MS) return
    r.lastFrameAt = t
    const file = `${String(++r.frameN).padStart(6, '0')}.jpg`
    try {
      mkdirSync(join(s.runDir, 'frames'), { recursive: true }) // a finished segment's stitch removes it
      writeFileSync(join(s.runDir, 'frames', file), Buffer.from(data, 'base64'))
      r.frames.push({ file, t })
    } catch {}
  })
}

function ensureVisual(r: Rec) {
  if (r.visual || r.visualStarting || !wantsVisual(r.s)) return
  r.visualStarting = track(startVisual(r).catch(e => console.error('browserrec: visual start failed', e.message)).finally(() => { r.visualStarting = null }))
}

// Turn the frames captured so far into a video segment: video.webm, then video-2.webm, ...
function stitch(r: Rec): Promise<string | null> {
  const frames = r.frames
  r.frames = []
  const dir = join(r.s.runDir, 'frames')
  if (!frames.length) return Promise.resolve(null)
  if (!FFMPEG) return Promise.resolve(null) // frames stay on disk as JPEGs
  return track(stitchFrames(r.s.runDir, dir, frames))
}

function nextVideoName(runDir: string) {
  if (!existsSync(join(runDir, 'video.webm'))) return 'video.webm'
  let i = 2
  while (existsSync(join(runDir, `video-${i}.webm`))) i++
  return `video-${i}.webm`
}

// A window left recording for an hour had 15,830 frames, and ffmpeg ran at 200% CPU for over an
// hour on a Mac that was already swapping (2026-11-18). Long recordings are thinned to at most
// MAX_FRAMES (each kept frame shows until the next, so timing holds), the encode runs at low
// priority, and one that runs past STITCH_TIMEOUT_MS is stopped (the JPEG frames stay on disk).
export const MAX_FRAMES = 3000
const STITCH_TIMEOUT_MS = 10 * 60_000
export function thinFrames<T>(frames: T[], max = MAX_FRAMES): T[] {
  if (frames.length <= max) return frames
  const step = frames.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(frames[Math.floor(i * step)])
  if (out.at(-1) !== frames.at(-1)) out[out.length - 1] = frames.at(-1)!
  return out
}

// One encode at a time: each is ~120% CPU, and several recordings finishing (or being re-adopted
// after a restart) at once saturated the Mac.
let encodeChain: Promise<unknown> = Promise.resolve()
const leftoverQueued = new Set<string>()
function stitchFrames(runDir: string, dir: string, all: { file: string; t: number }[]): Promise<string | null> {
  const run = encodeChain.then(() => stitchFramesNow(runDir, dir, all))
  encodeChain = run.catch(() => {})
  return run
}
function stitchFramesNow(runDir: string, dir: string, all: { file: string; t: number }[]): Promise<string | null> {
  const frames = thinFrames(all)
  const name = nextVideoName(runDir)
  const out = join(runDir, name)
  writeFileSync(join(runDir, name + '.pending'), '')
  const list = ['ffconcat version 1.0']
  frames.forEach((f, i) => {
    const next = frames[i + 1]
    const dur = next ? Math.max(0.02, Math.min(10, (next.t - f.t) / 1000)) : 1
    list.push(`file '${f.file}'`, `duration ${dur.toFixed(3)}`)
  })
  list.push(`file '${frames.at(-1)!.file}'`) // the concat demuxer drops the last duration otherwise
  const listFile = join(dir, `list-${name}.txt`)
  writeFileSync(listFile, list.join('\n') + '\n')
  return new Promise(res => {
    const p = spawn(FFMPEG!, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'scale=1280:860:force_original_aspect_ratio=decrease,pad=1280:860:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
      '-r', '10', '-threads', '2', '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8', '-an', out], { stdio: ['ignore', 'ignore', 'pipe'] })
    try { if (p.pid) setPriority(p.pid, 15) } catch {}
    const timer = setTimeout(() => { err += `timed out after ${STITCH_TIMEOUT_MS / 60_000} min`; p.kill('SIGKILL') }, STITCH_TIMEOUT_MS)
    timer.unref()
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { err += e.message })
    p.on('close', code => {
      clearTimeout(timer)
      rmSync(join(runDir, name + '.pending'), { force: true })
      if (code === 0 && existsSync(out)) {
        for (const f of all) rmSync(join(dir, f.file), { force: true })
        rmSync(listFile, { force: true })
        try { if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true }) } catch {}
        res(name)
      } else { console.error('browserrec: ffmpeg failed', code, err.slice(0, 500)); rmSync(out, { force: true }); res(null) }
    })
  })
}

// ffmpeg processes encoding recording frames, with their parent pid (1 = its server is gone).
export function frameEncodes(): { pid: number; ppid: number; runDir: string; name: string }[] {
  let out = ''
  try { out = execFileSync('ps', ['-ww', '-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' }) } catch { return [] }
  return out.split('\n').flatMap(l => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m || !/ffmpeg/.test(m[3])) return []
    const f = m[3].match(/ -i (.+)\/frames\/list-(video(?:-\d+)?\.webm)\.txt /)
    return f ? [{ pid: Number(m[1]), ppid: Number(m[2]), runDir: f[1], name: f[2] }] : []
  })
}
export const encodesFor = (runDir: string) => frameEncodes().filter(e => e.runDir === runDir)

// Stop an encode whose server is gone and drop its half-written video; its frames stay on disk.
function stopOrphan(e: { pid: number; runDir: string; name: string }) {
  try { process.kill(e.pid, 'SIGKILL') } catch {}
  rmSync(join(e.runDir, e.name), { force: true }); rmSync(join(e.runDir, e.name + '.pending'), { force: true })
  console.log(`browserrec: stopped orphaned encode ${e.pid} of ${e.name}`)
}

// At startup: encodes a previous server left behind are stopped and queued again here, one at a
// time, from the frames still on disk.
function adoptOrphanEncodes() {
  if (!FFMPEG) return
  const root = resolve(B.REC_DIR) + sep
  const orphans = frameEncodes().filter(e => e.ppid === 1 && e.runDir.startsWith(root))
  for (const e of orphans) stopOrphan(e)
  for (const runDir of new Set(orphans.map(e => e.runDir))) {
    const fdir = join(runDir, 'frames')
    if (leftoverQueued.has(runDir) || !existsSync(fdir)) continue
    const left = readdirSync(fdir).filter(f => f.endsWith('.jpg')).sort()
    if (!left.length) continue
    leftoverQueued.add(runDir)
    track(stitchFrames(runDir, fdir, left.map((file, i) => ({ file, t: i * FRAME_MIN_MS }))).finally(() => leftoverQueued.delete(runDir)))
  }
}

// ---------- lifecycle ----------
function onOpen(s: B.Session) {
  for (const [old, r] of recs) if (old.owner === s.owner && old !== s) { finalize(r, false) }
  const r: Rec = { s, meta: loadMeta(s), netSeen: new Set(), visual: false, visualStarting: null, scriptId: null, stopFrames: null, poll: null, draining: false,
    rrBuf: [], rrBytes: 0, rrTimer: null, frames: [], frameN: 0, lastFrameAt: 0, sensitive: false }
  recs.set(s, r)
  // frames left by a perch that went away without closing (re-attach): stitch them first
  const fdir = join(s.runDir, 'frames')
  if (existsSync(fdir)) {
    const left = readdirSync(fdir).filter(f => f.endsWith('.jpg')).sort()
    r.frameN = left.length ? Number(left.at(-1)!.slice(0, 6)) || left.length : 0
    // A server restart leaves its ffmpeg running with nobody to stop it (ppid 1), and the next server
    // started a second encode of the same frames: five encodes at ~120% CPU each on 2026-11-25, when
    // auto-m8 restarted every few minutes. Stop orphaned encodes (their frames are still on disk) and
    // leave the run alone while another live server is encoding it.
    const running = encodesFor(s.runDir)
    for (const e of running.filter(e => e.ppid === 1)) stopOrphan(e)
    const busy = running.some(e => e.ppid !== 1)
    if (left.length && FFMPEG && !busy && !leftoverQueued.has(s.runDir)) {
      leftoverQueued.add(s.runDir)
      track(stitchFrames(s.runDir, fdir, left.map((file, i) => ({ file, t: i * FRAME_MIN_MS }))).finally(() => leftoverQueued.delete(s.runDir)))
    }
  }
  noteUrl(r)
  writeMeta(r)
  ensureVisual(r)
}

function finalize(r: Rec, closing: boolean) {
  flushNet(r)
  flushRr(r)
  noteUrl(r)
  r.meta.end = Date.now()
  writeMeta(r)
  if (closing) {
    recs.delete(r.s)
    if (r.poll) { clearInterval(r.poll); r.poll = null }
    r.visual = false
    const stop = r.stopFrames
    r.stopFrames = null
    if (stop) track(stop().catch(() => {}))
  }
  return stitch(r)
}

export function installRecorder() {
  if ((globalThis as any).__perchRecorderInstalled) return
  ;(globalThis as any).__perchRecorderInstalled = true
  adoptOrphanEncodes()
  B.browserHooks.add(e => {
    const s = e.session
    if (e.type === 'open') return onOpen(s)
    let r = recs.get(s)
    if (!r) { onOpen(s); r = recs.get(s)! }
    if (s.goal && r.meta.goal !== s.goal) r.meta.goal = s.goal
    switch (e.type) {
      case 'navigate':
        noteUrl(r); flushNet(r); writeMeta(r); ensureVisual(r)
        // start recording the new document right away, not at the next poll
        if (r.visual) { const rr = r; setTimeout(() => { drain(rr) }, 30) }
        return
      case 'step':
        r.meta.steps++
        noteUrl(r); flushNet(r); writeMeta(r); ensureVisual(r)
        return
      case 'finish': {
        const goal = r.meta.goal ?? ''
        r.meta.goals.push({ goal, ok: !!e.ok, at: Date.now() })
        r.meta.outcome = e.ok ? 'ok' : 'failed'
        track(finalize(r, false))
        return
      }
      case 'close':
        track(finalize(r, true))
        return
    }
  })
}
installRecorder()

// Everything written so far is on disk and every video stitched (tests; shutdown).
export async function recorderIdle() {
  for (const r of recs.values()) { flushNet(r); flushRr(r) }
  while (pending.size) await Promise.allSettled([...pending])
}
// Flush one session's buffers now, after giving the page's 400ms batch time to arrive (without
// Runtime.enable we don't learn the recorder world's context id, so we can't ask it to flush).
export async function flushRecording(s: B.Session, waitMs = 600) {
  const r = recs.get(s)
  if (!r) return
  if (r.visual) { while (r.draining) await new Promise(res => setTimeout(res, 20)); await drain(r) }
  void waitMs
  flushNet(r); flushRr(r); writeMeta(r)
}
export const isRecordingVisual = (s: B.Session) => !!recs.get(s)?.visual

// ---------- reading recordings (API) ----------
const safeId = (id: string) => /^[\w.-]+$/.test(id) && id !== '.' && id !== '..'
export function recordingDir(id: string): string | null {
  if (!safeId(id)) return null
  const root = resolve(B.REC_DIR)
  const d = resolve(root, id)
  if (!d.startsWith(root + sep) || !existsSync(d) || !statSync(d).isDirectory()) return null
  return d
}

function dirSize(d: string): number {
  let n = 0
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name)
    try { n += f.isDirectory() ? dirSize(p) : statSync(p).size } catch {}
  }
  return n
}

const videosIn = (d: string) => readdirSync(d).filter(f => /^video(-\d+)?\.webm$/.test(f)).sort((a, b) => (a === 'video.webm' ? -1 : b === 'video.webm' ? 1 : Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])))

export function listRecordings() {
  if (!existsSync(B.REC_DIR)) return []
  const out = []
  for (const id of readdirSync(B.REC_DIR)) {
    const d = join(B.REC_DIR, id)
    try { if (!statSync(d).isDirectory()) continue } catch { continue }
    let meta: Partial<Meta> = {}
    try { meta = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8')) } catch {}
    let steps = meta.steps
    if (steps == null) try { steps = readFileSync(join(d, 'actions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length } catch { steps = 0 }
    const start = meta.start ?? statSync(d).birthtimeMs
    const live = [...B.sessions.values()].some(s => s.runDir === d)
    const end = meta.end ?? (live ? Date.now() : statSync(d).mtimeMs)
    out.push({ id, owner: meta.owner ?? null, goal: meta.goal ?? null, outcome: meta.outcome ?? null, start, end, duration: Math.max(0, end - start), steps, urls: (meta.urls ?? []).length,
      live, hasVideo: videosIn(d).length > 0, videos: videosIn(d), hasRrweb: existsSync(join(d, 'rrweb.jsonl.gz')), size: dirSize(d) })
  }
  return out.sort((a, b) => b.start - a.start)
}

export function readEvents(dir: string): any[] {
  const f = join(dir, 'rrweb.jsonl.gz')
  if (!existsSync(f)) return []
  const text = gunzipSync(readFileSync(f)).toString('utf8')
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const FILES: Record<string, string> = { 'actions.jsonl': 'application/x-ndjson', 'network.jsonl': 'application/x-ndjson', 'meta.json': 'application/json', 'path.json': 'application/json' }
// What GET /api/browser/recordings/:id/:file sends, or null for 404.
export function recordingFile(id: string, file: string): { type: string; body?: Buffer | string; path?: string } | null {
  const d = recordingDir(id)
  if (!d) return null
  if (FILES[file]) { const p = join(d, file); return existsSync(p) ? { type: FILES[file], body: readFileSync(p) } : null }
  if (file === 'rrweb.jsonl.gz' || file === 'rrweb.json') {
    if (!existsSync(join(d, 'rrweb.jsonl.gz'))) return null
    const text = gunzipSync(readFileSync(join(d, 'rrweb.jsonl.gz'))).toString('utf8')
    return { type: 'application/json', body: `[${text.split('\n').filter(Boolean).join(',')}]` }
  }
  if (/^video(-\d+)?\.webm$/.test(file)) { const p = join(d, file); return existsSync(p) ? { type: 'video/webm', path: p } : null }
  return null
}

let playerAssets: { js: string; css: string } | null | undefined
function player() {
  if (playerAssets !== undefined) return playerAssets
  const js = asset('rrweb-player', ['dist/index.js', 'dist/rrweb-player.umd.cjs', 'dist/index.umd.cjs', 'dist/rrweb-player.js'], /^(index|rrweb-player).*\.c?js$/)
  const css = asset('rrweb-player', ['dist/style.css', 'dist/index.css'], /\.css$/)
  playerAssets = js ? { js: readFileSync(js, 'utf8'), css: css ? readFileSync(css, 'utf8') : '' } : null
  return playerAssets
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const inlineScript = (js: string) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

// A self-contained page: rrweb-player inlined, events and actions fetched from the sibling file routes.
export function replayHtml(id: string): string | null {
  const d = recordingDir(id)
  if (!d) return null
  let meta: Partial<Meta> = {}
  try { meta = JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8')) } catch {}
  let actions: any[] = []
  try { actions = readFileSync(join(d, 'actions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch {}
  const p = player()
  const videos = videosIn(d)
  const title = `${meta.goal ?? 'Browser recording'} · ${id}`
  const actionItems = actions.map((a, i) => {
    const target = a.locator ? `${a.locator.role} "${a.locator.name}"` : a.url ?? a.text ?? a.key ?? ''
    const val = a.value != null && a.do !== 'navigate' ? ` = ${String(a.value).slice(0, 60)}` : ''
    return `<li data-at="${Number(a.at) - Number(a.took ?? 0)}"><b>${i + 1}. ${esc(a.do)}</b> ${esc(String(target).slice(0, 120))}${esc(val)}<small>${a.took ?? 0}ms${a.irreversible ? ' · irreversible' : ''}</small></li>`
  }).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${p?.css ?? ''}
body{margin:0;font:13px -apple-system,system-ui,sans-serif;background:#f4f4f2;color:#222;display:flex;height:100vh}
#main{flex:1;overflow:auto;padding:12px}#side{width:340px;overflow:auto;border-left:1px solid #ddd;background:#fff;padding:12px}
h1{font-size:15px;margin:0 0 8px}ol{list-style:none;padding:0;margin:0}li{padding:6px 4px;border-bottom:1px solid #eee;cursor:pointer}li:hover{background:#f0f4ff}
li small{display:block;color:#888}.muted{color:#888}video{max-width:100%;margin-top:12px;border:1px solid #ddd}</style></head>
<body><div id="main"><h1>${esc(title)}</h1>
<div class="muted">${esc(meta.owner ?? '')} · ${meta.start ? new Date(meta.start).toISOString() : ''}${meta.outcome ? ` · ${esc(meta.outcome)}` : ''} · ${actions.length} steps</div>
<div id="player"><p class="muted">Loading the DOM recording…</p></div>
${videos.map(v => `<video src="${esc(v)}" controls preload="metadata"></video>`).join('\n')}
</div><div id="side"><h1>Actions</h1><ol id="actions">${actionItems || '<li class="muted">No steps.</li>'}</ol></div>
${p ? `<script>${inlineScript(p.js)}</script>` : ''}
<script>
(async function(){
  var box = document.getElementById('player'), inst = null, first = 0;
  try {
    var r = await fetch('rrweb.jsonl.gz');
    if (!r.ok) { box.innerHTML = '<p class="muted">No DOM recording for this run (visual recording was off).</p>'; return }
    var events = await r.json();
    if (events.length < 2) { box.innerHTML = '<p class="muted">The DOM recording is empty.</p>'; return }
    first = events[0].timestamp;
    var P = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer);
    if (!P) { box.innerHTML = '<p class="muted">rrweb-player is not installed on this auto-m8.</p>'; return }
    box.innerHTML = '';
    inst = new P({ target: box, props: { events: events, width: Math.min(1100, box.clientWidth || 1000), height: 640, autoPlay: false, showController: true } });
  } catch (e) { box.innerHTML = '<p class="muted">Could not load the recording: ' + String(e && e.message || e).replace(/</g, '&lt;') + '</p>' }
  document.getElementById('actions').addEventListener('click', function (ev) {
    var li = ev.target.closest('li[data-at]'); if (!li || !inst || !first) return;
    var off = Math.max(0, Number(li.dataset.at) - first);
    try { inst.goto ? inst.goto(off) : inst.getReplayer().pause(off) } catch (e) {}
  });
})();
</script></body></html>`
}
