// The floating window. All the work happens in the perch server; this only owns the window:
// always-on-top, a global show/hide shortcut, size presets, and remembering where you left it.
const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, nativeTheme, screen, shell, systemPreferences } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, readFileSync, openSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const ROOT = join(__dirname, '..')
// The downloaded auto-m8.app (DMG) carries its own Node 26 for the server, in Resources/node. A checkout
// (npm run app, the setup launcher) runs the server on your own Node, as before.
const PACKAGED = app.isPackaged === true
const BUNDLED_NODE = PACKAGED ? join(process.resourcesPath, 'node/node') : null
// Your terminal's PATH (claude, gh, codex live there), read once from a login shell. The bundled Node's
// folder goes last, so tools that shell out to `node` find one even on a Mac without Node.
let loginPath = null
function packagedPath() {
  if (loginPath == null) {
    const r = spawnSync(process.env.SHELL || '/bin/zsh', ['-lc', 'printf "\\n@@PATH@@%s" "$PATH"'], { encoding: 'utf8', timeout: 10_000 })
    loginPath = (r.stdout || '').split('@@PATH@@').slice(1).pop()?.trim() || [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':')
  }
  return `${loginPath}:${join(process.resourcesPath, 'node')}`
}
const BASE = join(os.homedir(), 'Library/Application Support/perch')
const DATA = process.env.PERCH_DATA ?? BASE
const read = () => { try { return JSON.parse(readFileSync(join(DATA, 'settings.json'), 'utf8')) } catch { return {} } }
const settings = read()

// Profiles (Work, Personal…): each is its own perch server with its own data and accounts. Every
// enabled profile runs; the window shows one at a time. The list lives in profiles.json (server/profile.ts).
const DEFAULT_PROFILES = [
  { id: 'work', label: 'Work', port: Number(process.env.PERCH_PORT ?? settings.port ?? 4777), dataDir: DATA, enabled: true },
  { id: 'personal', label: 'Personal', port: 4778, dataDir: join(BASE, 'profiles/personal'), enabled: false },
]
const profilesFile = join(BASE, 'profiles.json')
const readProfiles = () => {
  let saved = {}
  try { saved = JSON.parse(readFileSync(profilesFile, 'utf8')) } catch {}
  const list = DEFAULT_PROFILES.map(d => ({ ...d, ...(saved.profiles ?? []).find(s => s.id === d.id) })).concat((saved.profiles ?? []).filter(s => !DEFAULT_PROFILES.some(d => d.id === s.id)))
  return { list, active: saved.active ?? 'work', saved }
}
const writeActive = id => { const { saved } = readProfiles(); try { require('node:fs').writeFileSync(profilesFile, JSON.stringify({ ...saved, active: id }, null, 2)) } catch {} }
let activeId = process.env.PERCH_DATA ? 'work' : readProfiles().active // a test run (PERCH_DATA) stays on its own server
const profileOf = id => readProfiles().list.find(p => p.id === id) ?? readProfiles().list[0]
const urlOf = p => `http://127.0.0.1:${p.port}`
let URL = urlOf(profileOf(activeId))
let win = null
const servers = new Map()
app.setPath('userData', join(DATA, 'electron')) // keep Chromium's caches out of the data folder

// Always with a timeout: a hung server accepts the connection and never answers, and an
// unbounded fetch left the shell waiting on it with no window (2026-11-10).
const healthyAt = (p, ms = 3000) => fetch(`${urlOf(p)}/api/health`, { signal: AbortSignal.timeout(ms) }).then(r => r.ok).catch(() => false)
const healthy = () => healthyAt(profileOf(activeId))
const logTo = (p, msg) => { try { require('node:fs').appendFileSync(join(p.dataDir, 'server.log'), `[${new Date().toISOString()}] auto-m8 shell: ${msg}\n`) } catch {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Whatever holds a profile's port but doesn't answer is a hung perch: stop it so a fresh one can
// listen. SIGTERM, then SIGKILL. A process stuck in the kernel ignores even SIGKILL; say so.
const HANG = 'auto-m8 stopped answering health checks for 30s; the app restarted it'
async function freePort(p, reason = HANG) {
  const r = spawnSync('lsof', ['-ti', `tcp:${p.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  const pids = (r.stdout || '').split('\n').map(Number).filter(n => n > 0 && n !== process.pid)
  if (!pids.length) return
  if (reason === HANG) for (const pid of pids) reason += await snapshotHang(p, pid)
  try { require('node:fs').writeFileSync(join(p.dataDir, 'restart-reason'), reason) } catch {} // the next boot records why (Health → Availability)
  logTo(p, `${p.id}: stopping unresponsive server ${pids.join(', ')} on port ${p.port}`)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  for (const pid of pids) try { process.kill(pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(250)
  for (const pid of pids.filter(alive)) try { process.kill(pid, 'SIGKILL') } catch {}
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(250)
  const stuck = pids.filter(alive)
  if (stuck.length) logTo(p, `${p.id}: server ${stuck.join(', ')} survives SIGKILL (stuck in the kernel); port ${p.port} stays taken`)
}

// Before a frozen server is killed, keep evidence of what froze it. The 2026-11-14 freeze left
// nothing: the stall logger only writes once the loop frees up. Two views, both proven on a frozen
// node: the JS stack (SIGUSR1 opens the inspector on its own thread; Debugger.pause interrupts busy
// JavaScript) and macOS `sample` (native stacks, which still show a process stuck in a syscall such
// as a FIFO open, where JS can't be paused). Both go to <data>/hangs and the stack into the reason.
const inspectPort = p => p.port + 5000
function jsStack(p, pid) {
  return new Promise(async resolve => {
    const t = setTimeout(() => resolve(null), 6000)
    try {
      process.kill(pid, 'SIGUSR1')
      let list
      for (let i = 0; i < 12 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${inspectPort(p)}/json/list`, { signal: AbortSignal.timeout(1000) })).json() } catch { await sleep(250) } }
      if (!list?.[0]) { clearTimeout(t); return resolve(null) }
      const ws = new WebSocket(list[0].webSocketDebuggerUrl)
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Debugger.paused') { clearTimeout(t); try { ws.close() } catch {} resolve(m.params.callFrames.map(f => `${f.functionName || '(anonymous)'} ${f.url.replace(/^file:\/\//, '').replace(ROOT + '/', '')}:${f.location.lineNumber + 1}`)) } }
      ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Debugger.enable' })); ws.send(JSON.stringify({ id: 2, method: 'Debugger.pause' })) }
      ws.onerror = () => { clearTimeout(t); resolve(null) }
    } catch { clearTimeout(t); resolve(null) }
  })
}
async function snapshotHang(p, pid) {
  const fs = require('node:fs')
  const dir = join(p.dataDir, 'hangs'), stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const stack = await jsStack(p, pid)
  const out = join(dir, `${stamp}-${pid}.sample.txt`)
  spawnSync('sample', [String(pid), '2', '-file', out], { timeout: 20_000 })
  if (stack) try { fs.writeFileSync(join(dir, `${stamp}-${pid}.js.txt`), stack.join('\n') + '\n') } catch {}
  logTo(p, `${p.id}: hang snapshot of ${pid}: ${stack ? `JS stack ${stack.slice(0, 6).join(' < ')}` : 'no JS stack (blocked outside JavaScript)'}; native: ${fs.existsSync(out) ? out : 'no sample'}`)
  return ` (frozen in: ${stack ? stack.slice(0, 4).join(' < ') : 'native code, see hangs/'})`
}

// A profile's server runs on your own Node (node-pty is built for it), through a login shell so it
// sees the same PATH as your terminal (claude, gh). If one is already running and answers, reuse it.
// A server we spawned that is alive but doesn't answer yet is starting up (reattaching chats,
// indexing; it binds the port only after that). Wait for it instead of spawning a second one: that
// double start hit EADDRINUSE 17 times on 2026-11-12.
const starting = new Map()
// One start at a time per profile: the health loop and a crash restart used to run this at once,
// and each spawned a server (two reattached the same 18 chats on 2026-11-14).
const ensuring = new Map()
function ensureServerFor(p) {
  if (!ensuring.has(p.id)) ensuring.set(p.id, startServerFor(p).finally(() => ensuring.delete(p.id)))
  return ensuring.get(p.id)
}
// A server is "booting" until it first answers, for at most BOOT_GRACE. Only then can it be hung:
// a frozen server that had been answering is stopped at once (with a snapshot), not waited on.
const BOOT_GRACE = 120_000
const answered = new Set() // pids that have answered /api/health at least once
const aliveKid = c => c && c.exitCode === null && c.signalCode === null
const booting = p => { const k = servers.get(p.id); return aliveKid(k) && !answered.has(k.pid) && Date.now() - (starting.get(p.id) ?? 0) < BOOT_GRACE }
async function startServerFor(p) {
  if (await healthyAt(p)) { const k = servers.get(p.id); if (k) answered.add(k.pid); return }
  const prev = servers.get(p.id)
  if (booting(p)) { // still starting: give it until its grace runs out, checking every second
    while (booting(p)) { if (await healthyAt(p, 1000)) { answered.add(prev.pid); return } await sleep(1000) }
    if (aliveKid(prev) && answered.has(prev.pid)) return
  }
  if (aliveKid(prev)) logTo(p, `${p.id}: server ${prev.pid} ${answered.has(prev.pid) ? 'stopped answering' : `never answered in ${BOOT_GRACE / 1000}s`}, stopping it`)
  servers.delete(p.id) // whatever we stop now is being replaced, not crashing: its exit must not start another
  await freePort(p) // snapshots and stops whatever holds the port
  if (aliveKid(prev)) { try { prev.kill('SIGKILL') } catch {} } // one that never got as far as listening
  // Wait for the port to be free before starting another: one that can't listen only reattaches
  // chats and dies on EADDRINUSE.
  for (let i = 0; i < 40 && (spawnSync('lsof', ['-ti', `tcp:${p.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '').trim(); i++) await sleep(250)
  require('node:fs').mkdirSync(p.dataDir, { recursive: true })
  const log = openSync(join(p.dataDir, 'server.log'), 'a')
  const shellPath = process.env.SHELL || '/bin/zsh'
  starting.set(p.id, Date.now())
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '', PERCH_DATA: p.dataDir, PERCH_PORT: String(p.port), PERCH_PROFILE: p.id }
  const child = PACKAGED
    ? spawn(BUNDLED_NODE, [`--inspect-port=${inspectPort(p)}`, join(ROOT, 'server/main.ts')], { cwd: ROOT, stdio: ['ignore', log, log], env: { ...env, PATH: packagedPath(), PERCH_PACKAGED: '1' } })
    : spawn(shellPath, ['-lc', `exec node --inspect-port=${inspectPort(p)} "${join(ROOT, 'server/main.ts')}"`], { cwd: ROOT, stdio: ['ignore', log, log], env })
  require('node:fs').closeSync(log) // the child has its own copy; keeping ours leaked one per restart (17 open on 2026-11-14)
  servers.set(p.id, child)
  child.on('exit', (code, signal) => onServerExit(p, child, code, signal))
  for (let i = 0; i < 60 && !(await healthyAt(p)); i++) await new Promise(r => setTimeout(r, 250))
}
const ensureServer = () => ensureServerFor(profileOf(activeId))

// A server that dies (a crash, out of memory, killed) comes straight back, instead of after the
// health check's three misses (~30s of "reconnecting"). Quick repeated deaths back off up to 30s,
// so a server that can't start doesn't spin.
const exits = new Map()
function onServerExit(p, child, code, signal) {
  if (quitting || servers.get(p.id) !== child || !enabledProfiles().some(x => x.id === p.id)) return
  // Code 3: another live server already holds this data folder's lock (server/single.ts). Starting
  // again would only lose again; the health loop takes over if that one stops answering.
  if (code === 3) { servers.delete(p.id); logTo(p, `${p.id}: another server already serves this folder; not starting a second one`); return }
  // A clean stop (code 0: SIGTERM/restart.sh/an agent loading new code) comes back at once and
  // doesn't count toward the back-off; only real crashes do.
  const prev = exits.get(p.id) ?? { at: 0, n: 0 }
  const clean = code === 0
  const n = clean ? prev.n : Date.now() - prev.at < 60_000 ? prev.n + 1 : 0
  if (!clean) exits.set(p.id, { at: Date.now(), n })
  const wait = clean ? 200 : Math.min(30_000, 500 * 2 ** n)
  logTo(p, `${p.id} server exited (${signal ?? `code ${code}`}), starting it again in ${Math.round(wait / 1000)}s`)
  setTimeout(async () => {
    if (quitting) return
    await ensureServerFor(p) // the page reconnects by itself (live updates and open chats), so no reload
  }, wait)
}
const enabledProfiles = () => process.env.PERCH_DATA ? [profileOf('work')] : readProfiles().list.filter(p => p.enabled || p.id === activeId)

// Keep every profile's server alive: if one stops answering (a crash, or it was killed), start it
// again, and reload the window if it's the one on screen, instead of leaving "reconnecting" up.
// One check at a time: the flag is taken before any await, so slow checks can't stack up and then
// all restart at once (17 servers per profile on 2026-11-10).
const misses = new Map()
let checking = false
// Waking from sleep: every chat, sync and agent helper resumes at once and the Mac is saturated for
// a minute or two. On 2026-11-16 after a 15h sleep, three misses within 30s of waking killed a working
// server, and its replacement (43s just to load modules) was killed too: two restarts, ~3 min down.
// After a wake, misses don't count for WAKE_GRACE. Wake is seen two ways: Electron's powerMonitor
// 'resume', and this loop's own timer arriving over a minute late (it doesn't run while asleep).
// The server's heartbeat file (server/main.ts): "<pid> <ms>", rewritten every 2s by its event loop.
const BEAT_STALE = 60_000
function beatOf(p) {
  try { const [pid, at] = require('node:fs').readFileSync(join(p.dataDir, 'server.heartbeat'), 'utf8').trim().split(' ').map(Number); return pid && at ? { pid, at } : null } catch { return null }
}
const WAKE_GRACE = 120_000
let wakeGraceUntil = 0, lastTick = Date.now()
function noteWake(how) {
  wakeGraceUntil = Date.now() + WAKE_GRACE
  for (const k of misses.keys()) misses.set(k, 0)
  shellLog(`woke from sleep (${how}): no hang verdicts for ${WAKE_GRACE / 1000}s`)
}
app.whenReady().then(() => { try { require('electron').powerMonitor.on('resume', () => noteWake('powerMonitor')) } catch {} })
setInterval(async () => {
  const gap = Date.now() - lastTick
  lastTick = Date.now()
  if (gap > 60_000 && Date.now() >= wakeGraceUntil) noteWake(`timer ${Math.round(gap / 1000)}s late`)
  if (checking) return
  checking = true
  try {
    for (const p of enabledProfiles()) {
      // 10s, not 3s: a live server under load stalls for up to ~10s (10.4s on 2026-11-14) and three
      // 3s misses in a row got it killed as hung, three times in ten minutes. A real hang still fails.
      if (await healthyAt(p, 10_000)) { const k = servers.get(p.id); if (k) answered.add(k.pid); misses.set(p.id, 0); continue }
      if (Date.now() < wakeGraceUntil) continue // just woke: slow, not hung
      // Making progress (its event loop rewrote the heartbeat within BEAT_STALE): slow under load, not
      // hung. Killing those made overload worse (9 restarts in 33 minutes on 2026-11-16).
      const beat = beatOf(p)
      if (beat && beat.pid === servers.get(p.id)?.pid && Date.now() - beat.at < BEAT_STALE) { misses.set(p.id, 0); continue }
      // Still booting (started by us, never answered, under 2 minutes): not hung, misses don't count.
      if (booting(p)) continue
      misses.set(p.id, (misses.get(p.id) ?? 0) + 1)
      if (misses.get(p.id) < 3) continue
      logTo(p, `${p.id} server not answering, restarting it`)
      try {
        await ensureServerFor(p)
        if (p.id === activeId && win && !win.isDestroyed() && await healthyAt(p)) win.webContents.reload()
      } finally { misses.set(p.id, 0) }
    }
  } finally { checking = false }
}, 10_000).unref?.()

// Switch the window to another profile: start its server if needed, then show it.
async function switchProfile(id) {
  const p = profileOf(id)
  if (!p || p.id === activeId) return activeId
  await ensureServerFor(p)
  activeId = p.id
  URL = urlOf(p)
  writeActive(p.id)
  if (win && !win.isDestroyed()) win.loadURL(URL)
  return activeId
}

function presetBounds(name) {
  const { workArea: a } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const m = 12
  switch (name) {
    case 'bar': return { width: 560, height: 56, x: Math.round(a.x + (a.width - 560) / 2), y: a.y + m }
    case 'compact': return { width: 400, height: 620, x: a.x + a.width - 400 - m, y: a.y + a.height - 620 - m }
    case 'side': return { width: 520, height: a.height - 2 * m, x: a.x + a.width - 520 - m, y: a.y + m }
    default: return { width: Math.min(1400, a.width - 80), height: Math.min(900, a.height - 80), x: a.x + 40, y: a.y + 40 }
  }
}

let saveTimer = null
function saveBounds() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || beforeMini || beforeTuck) return
    fetch(`${URL}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window: { bounds: win.getBounds() } }) }).catch(() => {})
  }, 600)
}

function createWindow() {
  const s = read()
  const bounds = s.window?.bounds ?? presetBounds('compact')
  win = new BrowserWindow({
    ...bounds, minWidth: 260, minHeight: 48,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 13 },
    vibrancy: 'sidebar', visualEffectState: 'active', backgroundColor: '#00000000',
    alwaysOnTop: s.window?.alwaysOnTop ?? true, fullscreenable: false, show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true }, // webview: canvas web tiles
  })
  if (s.window?.alwaysOnTop ?? true) win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadURL(URL)
  win.once('ready-to-show', () => win.show())
  // A load that fails (the page reloaded while the server was restarting) leaves Electron with an
  // empty page, which in this vibrancy window is just a see-through pane over the desktop. Retry
  // until the server answers. Same for a crashed or killed renderer.
  let retryTimer = null
  const retryLoad = why => {
    if (retryTimer || !win || win.isDestroyed()) return
    shellLog(`window: ${why}; loading again`)
    retryTimer = setTimeout(() => { retryTimer = null; if (win && !win.isDestroyed()) win.loadURL(URL) }, 1000)
  }
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) retryLoad(`load failed (${desc} ${code}) for ${url}`) // -3 = aborted by a newer navigation
  })
  win.webContents.on('render-process-gone', (_e, d) => retryLoad(`renderer gone (${d.reason})`))
  // ✕ hides the window instead of destroying it, so the Dock icon, the perch launcher and the
  // shortcut always have a window to bring back (and drafts and scroll survive). Quit still quits.
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide() } })
  win.on('moved', saveBounds)
  watchFocus()
  win.on('resized', saveBounds)
  win.on('resize', () => { if (beforeMini || beforeTuck) win.setWindowButtonVisibility(false) })
  // Drag the picture-in-picture window mostly off the side of the screen and it tucks into the edge.
  // On macOS 'moved' fires all through a drag, so wait until the window stops moving: tucking mid-drag
  // shrinks the window under your cursor and macOS keeps dragging it from where you grabbed the
  // wide one, flinging the tab off the edge.
  let dragTimer = null
  win.on('moved', () => {
    if (!beforeMini || beforeTuck) return
    clearTimeout(dragTimer)
    dragTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !beforeMini || beforeTuck) return
      const b = win.getBounds(), { workArea: a } = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
      const off = Math.max(a.x - b.x, b.x + b.width - (a.x + a.width))
      if (off > b.width * 0.35) setTuck(true)
    }, 300)
  })
  // The tab belongs on the edge: if anything moves it (a drag still going, macOS nudging it back on
  // screen), put it back once the moving stops.
  let snapTimer = null
  win.on('move', () => {
    if (!beforeTuck?.spot) return
    clearTimeout(snapTimer)
    snapTimer = setTimeout(() => {
      const t = beforeTuck?.spot
      if (!t || !win || win.isDestroyed()) return
      const b = win.getBounds()
      if (Math.abs(b.x - t.x) <= 2 && Math.abs(b.y - t.y) <= 2 && b.width === t.width && b.height === t.height) return
      // Moved by someone else. Put it back once (a drag that was still going); if macOS moves it
      // again, that edge is off limits (Stage Manager's strip, say), so try the next nearest edge,
      // and after a few tries leave it where macOS wants it rather than fight forever.
      const bt = beforeTuck
      if (!bt.putBack) { bt.putBack = true; win.setBounds(t, false); shellLog(`tab was moved to ${b.x},${b.y}; put it back on the ${bt.edge} edge`); return }
      osBlocked.add(`${bt.display}:${bt.edge}`)
      const next = ++bt.tries <= 3 && placeTab(bt.bounds)
      if (next && next.edge !== bt.edge) { Object.assign(bt, next, { putBack: false }); win.setBounds(next.spot, false); shellLog(`macOS keeps moving the tab off the ${[...osBlocked].pop()} edge; using the ${next.edge} edge`) }
      else { bt.spot = null; shellLog(`macOS keeps moving the tab (to ${b.x},${b.y}); leaving it there`) }
    }, 150)
  })
  // Links, artifacts and PRs open in your default browser, never inside the widget.
  // Links to perch itself navigate inside the window; everything else opens in its own app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^http:\/\/127\.0\.0\.1:47\d\d\//.test(url)) win.loadURL(url)
    else shell.openExternal(url)
    return { action: 'deny' }
  })
  // Canvas web tiles: no node, no preload, and their new windows open in your browser.
  win.webContents.on('will-attach-webview', (_e, prefs) => { delete prefs.preload; prefs.nodeIntegration = false; prefs.contextIsolation = true })
  win.webContents.on('did-attach-webview', (_e, wc) => wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } }))
  win.webContents.on('will-navigate', (e, url) => { if (!/^http:\/\/127\.0\.0\.1:47\d\d\//.test(url)) { e.preventDefault(); shell.openExternal(url) } })
}

let quitting = false
app.on('before-quit', () => { quitting = true })
// Bring the window forward, making a new one if it's gone.
function showWindow() {
  if (!win || win.isDestroyed()) return createWindow()
  if (beforeTuck) setTuck(false)
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}
function toggle() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !beforeTuck) win.hide()
  else showWindow()
}

// Collapse / expand from anywhere (a global shortcut, so it works while you're in another app):
// full window → picture-in-picture pill, and back. Tucked or hidden, it comes back expanded.
const COLLAPSE_KEY = settings.window?.collapseHotkey || 'Control+Alt+M'
function toggleCollapse() {
  if (!win || win.isDestroyed()) return createWindow()
  if (beforeTuck) setTuck(false)
  autoMinied = false
  if (beforeMini && win.isVisible() && !win.isMinimized()) {
    setMini(false); lastRestore = Date.now()
    win.show(); win.focus()
    shellLog('collapse shortcut: expanded')
  } else {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.showInactive()
    setMini(true)
    shellLog('collapse shortcut: collapsed')
  }
}

// Pop-out: one page of the app (the architecture explorer) in its own window, so it can sit on another screen.
// Its links back into the app open in the main window.
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):47\d\d\//
ipcMain.handle('popout', (_e, url) => {
  if (!LOCAL.test(String(url))) return false
  const w = new BrowserWindow({ width: 1500, height: 950, title: 'Explore', backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#fbfbfa',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } })
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    if (LOCAL.test(u) && !u.includes('popout=')) { win.loadURL(u.replace('localhost', '127.0.0.1')); win.show(); win.focus() }
    else if (!LOCAL.test(u)) shell.openExternal(u)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, u) => { if (!LOCAL.test(u)) { e.preventDefault(); shell.openExternal(u) } })
  w.loadURL(url)
  return true
})
// Canvas previews for Explore: render one board offscreen (?thumb=<id>: the board alone, no activity
// pings, so temporary boards don't get renewed), wait for its tiles, and return a small JPEG.
let thumbBusy = Promise.resolve(), thumbWin = null, thumbIdle = null
function thumbWindow() {
  if (thumbWin && !thumbWin.isDestroyed()) return thumbWin
  thumbWin = new BrowserWindow({ show: false, width: 1280, height: 720, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } })
  thumbWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  thumbWin.webContents.setAudioMuted(true)
  return thumbWin
}
ipcMain.handle('board-thumb', (_e, url) => {
  if (!LOCAL.test(String(url)) || !/[?&]thumb=/.test(String(url))) return null
  const job = thumbBusy.then(async () => {
    clearTimeout(thumbIdle)
    const w = thumbWindow()
    try {
      await Promise.race([w.loadURL(url), new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), 15000))])
      await new Promise(r => setTimeout(r, 6000)) // code tiles fetch data and draw
      const img = await w.webContents.capturePage()
      return img.resize({ width: 720, quality: 'good' }).toJPEG(72).toString('base64')
    } catch (e) { shellLog(`board thumb failed: ${e.message}`); return null }
    finally { thumbIdle = setTimeout(() => { if (thumbWin && !thumbWin.isDestroyed()) thumbWin.destroy(); thumbWin = null }, 60_000) }
  })
  thumbBusy = job.catch(() => null)
  return job
})
ipcMain.handle('pin', (_e, on) => { win.setAlwaysOnTop(!!on, 'floating'); return win.isAlwaysOnTop() })
ipcMain.handle('is-pinned', () => win.isAlwaysOnTop())
// Writing's Browse…: the native Finder sheet, markdown and text files only. Returns the path or null.
ipcMain.handle('pick-file', async (_e, start) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: typeof start === 'string' && start ? start : undefined, filters: [{ name: 'Markdown and text', extensions: ['md', 'markdown', 'mdx', 'txt'] }] })
  return r.canceled ? null : r.filePaths[0] ?? null
})
// Big decisions waiting on you show on the dock icon, so you see them without opening perch.
ipcMain.handle('badge', (_e, text) => { try { app.dock?.setBadge(String(text ?? '')) } catch {} })
ipcMain.handle('preset', (_e, name) => { win.setBounds(presetBounds(name), true); saveBounds() })
// Double-click on the window's header does what macOS's "Double-click a window's title bar" setting says.
// Fill/Zoom toggle between filling the screen and the last size you picked; when the window got big some
// other way (dragged, preset, restored bounds) there's no smaller size saved, so fall back to a centred 80%.
let beforeFill = null
ipcMain.handle('titlebar-dblclick', () => {
  if (!win || win.isDestroyed() || beforeMini || beforeTuck) return 'none'
  const act = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') || 'Fill'
  if (act === 'Minimize') { win.minimize(); return 'minimized' }
  if (act === 'None') return 'none'
  const b = win.getBounds(), { workArea: a } = screen.getDisplayMatching(b), near = (p, q) => Math.abs(p - q) <= 24
  const filled = near(b.x, a.x) && near(b.y, a.y) && near(b.x + b.width, a.x + a.width) && near(b.y + b.height, a.y + a.height)
  if (filled) {
    const back = beforeFill && beforeFill.width < a.width - 48 ? beforeFill
      : { width: Math.round(a.width * 0.8), height: Math.round(a.height * 0.8), x: Math.round(a.x + a.width * 0.1), y: Math.round(a.y + a.height * 0.1) }
    beforeFill = null
    win.setBounds(back, true)
  } else {
    beforeFill = b
    win.setBounds(a, true)
  }
  saveBounds()
  return filled ? 'restored' : 'filled'
})
// Picture in picture: shrink into the corner the window is nearest, always on top, and come back
// to exactly where it was. The page switches to its mini view from the window size.
// It starts as a slim pill (counts and an ask box); opening or starting a chat grows it into the
// card that shows that conversation. Both keep the corner they're anchored to.
const MINI = { pill: { w: 400, h: 52 }, card: { w: 340, h: 210 } }
let beforeMini = null, miniSpot = null, miniSize = 'pill'
ipcMain.handle('mini', (_e, on) => { autoMinied = false; if (beforeTuck) setTuck(false); return setMini(on) })
// The side panel: a tall, narrow chat column on the nearest side of the screen, still always on top
// and draggable by its header; resize it by its edges like any window.
let panelWidth = 400
const sizeFor = (size, a) => size === 'panel' ? { w: panelWidth, h: a.height - 24 } : MINI[size]
const tellSize = () => { try { win.webContents.send('mini-size', beforeMini ? miniSize : 'none') } catch {} }
ipcMain.handle('mini-size', (_e, size) => {
  if (!beforeMini || beforeTuck || !(MINI[size] || size === 'panel') || size === miniSize) return miniSize
  const b = win.getBounds(), { workArea: a } = screen.getDisplayMatching(b), { w, h } = sizeFor(size, a)
  if (miniSize === 'panel') panelWidth = Math.min(Math.max(b.width, 300), 640)
  const right = b.x + b.width / 2 > a.x + a.width / 2, bottom = b.y + b.height / 2 > a.y + a.height / 2
  let x = Math.min(Math.max(right ? b.x + b.width - w : b.x, a.x), a.x + a.width - w)
  let y = Math.min(Math.max(bottom ? b.y + b.height - h : b.y, a.y), a.y + a.height - h)
  if (size === 'panel') { x = right ? a.x + a.width - w - 12 : a.x + 12; y = a.y + 12 }
  miniSize = size; miniSpot = null; autoMinied = false // you asked for it: clicking into it shouldn't grow the full window
  win.setBounds({ x, y, width: w, height: h }, true)
  setTimeout(() => { if (beforeMini) win.setWindowButtonVisibility(false) }, 450)
  tellSize()
  return miniSize
})
function setMini(on) {
  if (on && !beforeMini) {
    beforeMini = { bounds: win.getBounds(), pinned: win.isAlwaysOnTop() }
    miniSize = 'pill'
    const b = beforeMini.bounds, { workArea: a } = screen.getDisplayMatching(b), m = 12, { w, h } = MINI.pill
    const right = b.x + b.width / 2 > a.x + a.width / 2, bottom = b.y + b.height / 2 > a.y + a.height / 2
    win.setAlwaysOnTop(true, 'floating')
    // Where you last dragged the mini window to, if that's on this screen; otherwise the nearest corner.
    const spot = miniSpot && screen.getDisplayMatching(miniSpot).id === screen.getDisplayMatching(b).id ? miniSpot : null
    const sr = spot && spot.x + spot.width / 2 > a.x + a.width / 2, sb = spot && spot.y + spot.height / 2 > a.y + a.height / 2
    const pos = spot ? { x: Math.min(Math.max(sr ? spot.x + spot.width - w : spot.x, a.x), a.x + a.width - w), y: Math.min(Math.max(sb ? spot.y + spot.height - h : spot.y, a.y), a.y + a.height - h) } : { x: right ? a.x + a.width - w - m : a.x + m, y: bottom ? a.y + a.height - h - m : a.y + m }
    miniSpot = null // set again only by a drag, not by this resize
    win.setBounds({ width: w, height: h, ...pos }, true)
    setTimeout(() => { miniSpot = spot }, 450) // ignore the move events from the animation
    // The mini view has its own expand button; the window buttons would sit on top of it.
    // Hidden again once the resize animation ends, because macOS can bring them back.
    win.setWindowButtonVisibility(false)
    setTimeout(() => { if (beforeMini) win.setWindowButtonVisibility(false) }, 450)
    tellSize()
    return 'mini'
  } else if (!on && beforeMini) {
    win.setBounds(beforeMini.bounds, true)
    win.setAlwaysOnTop(beforeMini.pinned, 'floating')
    win.setWindowButtonVisibility(beforeMini.bounds.width >= 640)
    beforeMini = null
    tellSize()
    return 'restored'
  }
  return beforeMini ? 'mini' : 'none'
}

// Tuck: perch slides off the nearest outer side edge of the screen it's on (left or right, never top or bottom),
// leaving a small tab flush against that edge. An edge that touches another display doesn't count:
// a tab there floats in the middle of the desktop (a laptop left of a monitor makes the monitor's
// left edge a seam). Click the tab (or press the show/hide shortcut) and it slides back out to
// exactly where and how big it was.
let beforeTuck = null
// over: how far the tab hangs off the screen, so its rounded corners sit out of sight and it reads
// as attached to the edge. Not at the top: macOS keeps windows below the menu bar.
const TAB = { long: 140, short: 12, over: 10 }
// Edges macOS won't let the tab stay on: Stage Manager pushes windows out of its strip (left side,
// or right when the Dock is on the left), plus any edge macOS moved the tab off this session.
const osBlocked = new Set()
function blockedEdges(displayId) {
  const out = new Set([...osBlocked].filter(k => k.startsWith(`${displayId}:`)).map(k => k.split(':')[1]))
  try {
    const def = (dom, key) => spawnSync('defaults', ['read', dom, key], { encoding: 'utf8', timeout: 1000 }).stdout.trim()
    if (def('com.apple.WindowManager', 'GloballyEnabled') === '1') { const side = def('com.apple.dock', 'orientation') === 'left' ? 'right' : 'left'; out.add(side); out.add(`strip-${side}`) }
  } catch {}
  return out
}
function placeTab(b) {
  const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  const { edge, bounds } = tuckSpot(b, d, screen.getAllDisplays().filter(o => o.id !== d.id).map(o => o.bounds), blockedEdges(d.id))
  return { edge, spot: bounds, display: d.id }
}
function tuckSpot(b, d, others, blocked = new Set()) {
  const a = d.workArea, f = d.bounds
  const clamp = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi)
  const y = clamp(b.y + b.height / 2 - TAB.long / 2, a.y, a.y + a.height - TAB.long)
  // Stage Manager's strip (about 250pt) also pushes away a top or bottom tab that sits over it.
  const STRIP = 280, lo = a.x + (blocked.has('strip-left') ? STRIP : 0), hi = a.x + a.width - TAB.long - (blocked.has('strip-right') ? STRIP : 0)
  const x = clamp(b.x + b.width / 2 - TAB.long / 2, lo, hi)
  const near = (p, q) => Math.abs(p - q) <= 1
  const overlap = (lo, hi, oLo, oHi) => Math.min(hi, oHi) - Math.max(lo, oLo) > 0
  const seam = {
    left: others.some(o => near(o.x + o.width, f.x) && overlap(y, y + TAB.long, o.y, o.y + o.height)),
    right: others.some(o => near(o.x, f.x + f.width) && overlap(y, y + TAB.long, o.y, o.y + o.height)),
    top: others.some(o => near(o.y + o.height, f.y) && overlap(x, x + TAB.long, o.x, o.x + o.width)),
    bottom: others.some(o => near(o.y, f.y + f.height) && overlap(x, x + TAB.long, o.x, o.x + o.width)),
  }
  // Only the side edges: a tab on the top or bottom gets lost under the menu bar and the Dock.
  const dist = { left: b.x - a.x, right: a.x + a.width - (b.x + b.width) }
  const free = Object.keys(dist).filter(e => !seam[e] && !blocked.has(e))
  const edge = (free.length ? free : Object.keys(dist)).sort((p, q) => dist[p] - dist[q])[0]
  const over = seam[edge] ? 0 : TAB.over
  const spot = {
    left: { x: a.x - over, y, width: TAB.short + over, height: TAB.long },
    right: { x: a.x + a.width - TAB.short, y, width: TAB.short + over, height: TAB.long },
    top: { x, y: a.y, width: TAB.long, height: TAB.short },
    bottom: { x, y: a.y + a.height - TAB.short, width: TAB.long, height: TAB.short + over },
  }[edge]
  return { edge, bounds: spot }
}
ipcMain.handle('tuck', (_e, on) => setTuck(on))
function setTuck(on) {
  if (on && !beforeTuck) {
    const b = win.getBounds(), { edge, spot: bounds, display } = placeTab(b)
    beforeTuck = { bounds: b, pinned: win.isAlwaysOnTop(), edge, spot: bounds, display, tries: 0, putBack: false }
    win.setMinimumSize(1, 1)
    win.setAlwaysOnTop(true, 'floating')
    win.setWindowButtonVisibility(false)
    win.setHasShadow(false)
    // No animation: an animated move across a display seam can land short of the edge.
    win.setBounds(bounds, false)
    const got = win.getBounds()
    if (Math.abs(got.x - bounds.x) > 2 || Math.abs(got.y - bounds.y) > 2) { win.setPosition(bounds.x, bounds.y); shellLog(`tuck landed at ${got.x},${got.y}, wanted ${bounds.x},${bounds.y}; moved it again`) }
    setTimeout(() => { if (beforeTuck) win.setWindowButtonVisibility(false) }, 450)
    shellLog(`tucked to the ${edge} edge at ${bounds.x},${bounds.y}`)
    return 'tucked'
  } else if (!on && beforeTuck) {
    autoTucked = false
    const { bounds, pinned } = beforeTuck
    beforeTuck = null
    win.setHasShadow(true)
    win.setBounds(bounds, true)
    win.setMinimumSize(260, 48)
    win.setAlwaysOnTop(beforeMini ? true : pinned, 'floating')
    win.setWindowButtonVisibility(!beforeMini && bounds.width >= 640)
    lastRestore = Date.now()
    return 'restored'
  }
  return beforeTuck ? 'tucked' : 'none'
}

// Never lost behind other windows: when other windows cover perch completely (macOS reports the
// page hidden while the window is still shown), it tucks into the edge tab, which stays on top.
// Click the tab, the shortcut, or switch to perch and it slides back out. Off in Settings → Window.
let autoTucked = false, occludeTimer = null
const autoTuckOn = () => read().window?.autoTuck !== false
ipcMain.on('occluded', (e, hidden) => {
  if (e.sender !== win?.webContents) return // a pop-out window being covered says nothing about the main one
  clearTimeout(occludeTimer)
  if (!hidden) return
  occludeTimer = setTimeout(() => {
    // Picture in picture wins: the mini window is already the "stay visible" answer, so never tuck it,
    // and when PiP is on, a covered full-size perch shrinks to the mini window instead of the edge tab.
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFocused() || beforeTuck || beforeMini) return
    if (Date.now() - lastRestore < 1500) return
    if (autoMiniOn()) { setMini(true); autoMinied = true; shellLog('picture in picture: on (other windows covered auto-m8)'); return }
    if (!autoTuckOn()) return
    setTuck(true); autoTucked = true; shellLog('tucked: other windows covered auto-m8')
  }, 400)
})

// Picture in picture by itself: click into another app and perch shrinks to its mini window (always
// on top, so it stays visible); come back to perch and it returns to where and how big it was. It
// shrinks at once (no vanish-then-reappear), and only an automatic shrink
// expands itself: if you made it mini (⧉), it stays mini. Off in Settings → Window.
const shellLog = msg => { try { require('node:fs').appendFileSync(join(profileOf(activeId).dataDir, 'server.log'), `[${new Date().toISOString()}] auto-m8 shell: ${msg}\n`) } catch {} }
let autoMinied = false, blurTimer = null, lastRestore = 0
const autoMiniOn = () => read().window?.autoMini !== false
function watchFocus() {
  win.on('blur', () => {
    clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isFocused() || !win.isVisible() || win.isMinimized() || beforeMini || beforeTuck || !autoMiniOn()) return
      if (Date.now() - lastRestore < 1500) return // just came back: don't bounce straight out again
      const b = win.getBounds()
      if (b.width < 480 || b.height < 330) return // already small enough to stay visible
      setMini(true); autoMinied = true; shellLog('picture in picture: on (you clicked away)')
    }, 60) // straight away: a long wait let the app you clicked cover perch before it popped back mini
  })
  // Pressing on the mini window to drag it also focuses it, so wait a moment before growing: if it
  // starts moving, it's a drag and it stays mini where you put it. A plain click still expands it.
  let growTimer = null
  const cancelGrow = () => { if (growTimer) { clearTimeout(growTimer); growTimer = null; shellLog('picture in picture: moved, staying mini') } }
  win.on('will-move', cancelGrow)
  win.on('move', () => { cancelGrow(); if (beforeMini && !beforeTuck) miniSpot = win.getBounds() })
  win.on('focus', () => {
    clearTimeout(blurTimer)
    if (autoTucked && beforeTuck) { setTuck(false); shellLog('untucked: you came back') }
    autoTucked = false
    if (!autoMinied || !beforeMini || beforeTuck) return
    const at = win.getBounds()
    clearTimeout(growTimer)
    growTimer = setTimeout(() => {
      growTimer = null
      if (!win || win.isDestroyed() || !win.isFocused() || !autoMinied || !beforeMini || beforeTuck) return
      const b = win.getBounds()
      if (b.x !== at.x || b.y !== at.y) return
      setMini(false); autoMinied = false; lastRestore = Date.now(); shellLog('picture in picture: off (you came back)')
    }, 300)
  })
}

ipcMain.handle('profile-switch', (_e, id) => switchProfile(id))
ipcMain.handle('profile-active', () => activeId)
ipcMain.handle('buttons', (_e, on) => win.setWindowButtonVisibility(!!on))
ipcMain.handle('theme', (_e, t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system' }) // window chrome and vibrancy follow

// One perch at a time: opening it again (perch.app, `npm run app`) brings the window forward instead.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (app.isReady()) showWindow() })

// Show as auto-m8 (not Electron) in the Dock, menu bar and app switcher.
app.setName('auto-m8')
app.whenReady().then(async () => {
  try { if (app.dock && !PACKAGED) app.dock.setIcon(join(ROOT, 'web/public/icon-180.png')) } catch {} // the packaged app has its own icon
  await ensureServer()
  createWindow()
  // The other enabled profiles start in the background, so their agents keep running too.
  for (const p of enabledProfiles()) if (p.id !== activeId) ensureServerFor(p).catch(() => {})
  const HOTKEY = settings.window?.hotkey || 'Control+Alt+Space'
  try { if (!globalShortcut.register(HOTKEY, toggle)) shellLog(`show/hide shortcut ${HOTKEY} is taken by another app`) } catch (e) { console.error('hotkey', e) }
  try { if (!globalShortcut.register(COLLAPSE_KEY, toggleCollapse)) shellLog(`collapse shortcut ${COLLAPSE_KEY} is taken by another app`) } catch (e) { console.error('collapse hotkey', e) }
  app.on('activate', showWindow)
})
app.on('window-all-closed', () => {})

// The menu bar: reload the window, restart perch with fresh code (rebuilds the web app, restarts
// the servers and this shell), and quit. The window has no chrome of its own for these.
function restartPerch() {
  if (!PACKAGED) { // the packaged app ships its web build; there's nothing to rebuild
    shellLog('restart from the menu: rebuilding the web app')
    const r = spawnSync(process.env.SHELL || '/bin/zsh', ['-lc', 'npx vite build'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
    if (r.status !== 0) shellLog(`web build failed, restarting on the last build:\n${(r.stderr || r.stdout || '').slice(-2000)}`)
  }
  // Stop every profile's server, including ones an earlier shell started (will-quit only stops our
  // own children), so the relaunch really runs fresh server code. Chats are detached and reattach.
  quitting = true // the servers stopped below are not crashes: don't bring them back
  Promise.all(enabledProfiles().map(p => freePort(p, 'you restarted auto-m8 from the menu'))).finally(() => {
    app.relaunch({ args: process.argv.slice(1) })
    app.quit() // the relaunched shell starts fresh servers
  })
}
const buildMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'auto-m8', submenu: [
    ...(updateReady ? [{ label: `Restart to update (${updateReady})`, click: installUpdate }, { type: 'separator' }] : []),
    { label: 'Show / hide', accelerator: settings.window?.hotkey || 'Control+Alt+Space', click: toggle, registerAccelerator: false },
    { type: 'separator' },
    { label: 'Collapse / expand', accelerator: COLLAPSE_KEY, click: toggleCollapse, registerAccelerator: false },
    { label: 'Tuck into the edge / bring back', accelerator: 'CmdOrCtrl+Shift+.', click: () => win && !win.isDestroyed() && setTuck(!beforeTuck) },
    { type: 'separator' },
    { label: 'Reload window', accelerator: 'CmdOrCtrl+R', click: () => win && !win.isDestroyed() && win.webContents.reload() },
    { label: 'Restart auto-m8 (rebuild + restart servers)', accelerator: 'CmdOrCtrl+Shift+R', click: restartPerch },
    { type: 'separator' },
    { role: 'hide' }, { role: 'quit', label: 'Quit auto-m8' },
  ] },
  { role: 'editMenu' },
  { label: 'View', submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  { role: 'windowMenu' },
]))
app.whenReady().then(buildMenu) // keep running: the shortcut brings it back

// Updates (the packaged app only): check GitHub Releases on launch and every 6h, download in the
// background, and install on the next quit. One quiet menu item restarts into it sooner.
let updateReady = null
function installUpdate() {
  quitting = true
  const { autoUpdater } = require('electron-updater')
  autoUpdater.quitAndInstall()
}
if (PACKAGED && !process.env.PERCH_NO_UPDATE) app.whenReady().then(() => {
  let autoUpdater
  try { ({ autoUpdater } = require('electron-updater')) } catch (e) { shellLog(`updates off: ${e.message}`); return }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: m => shellLog(`update: ${m}`), warn: m => shellLog(`update: ${m}`), error: () => {}, debug: () => {} } // errors: the 'error' event below, once
  autoUpdater.on('update-downloaded', info => { updateReady = info.version; shellLog(`update ${info.version} downloaded; installs on quit`); buildMenu() })
  autoUpdater.on('error', e => shellLog(`update check failed: ${e?.message ?? e}`))
  const check = () => autoUpdater.checkForUpdates().catch(() => {}) // already logged by the 'error' event
  check()
  setInterval(check, 6 * 3600_000).unref?.()
})
// Right-click the Dock icon: always a way out, even when the window is blank or stuck.
// Force quit skips every quit handler (app.exit), after stopping our own servers.
app.whenReady().then(() => app.dock?.setMenu(Menu.buildFromTemplate([
  { label: 'Show auto-m8', click: showWindow },
  { label: 'Reload window', click: () => win && !win.isDestroyed() && win.webContents.reload() },
  { label: 'Restart auto-m8', click: restartPerch },
  { type: 'separator' },
  { label: 'Force quit auto-m8', click: () => { quitting = true; for (const s of servers.values()) { try { s.kill('SIGKILL') } catch {} } app.exit(0) } },
])))
app.on('will-quit', () => { globalShortcut.unregisterAll(); for (const s of servers.values()) s.kill() })
