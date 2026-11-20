// `npm run doctor`: everything you'd otherwise check by hand across ps/lsof/curl when Mothership
// won't launch, won't show what you expect, or you just want to know what's running and where.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PERCH_PORT ?? 4777)
const DATA = process.env.PERCH_DATA ?? join(homedir(), 'Library/Application Support/perch')
const tilde = (p) => p.replace(homedir(), '~')
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`)
const info = (s) => console.log(`  · ${s}`)
const has = (cmd) => { try { execFileSync('/bin/zsh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' }); return true } catch { return false } }

console.log(`Mothership doctor — ${ROOT}\n`)

const major = Number(process.versions.node.split('.')[0])
major >= 26 ? ok(`Node ${process.version}`) : bad(`Node ${process.version} (need 26+)`)

for (const c of ['claude', 'gh', 'ollama']) {
  if (has(c)) ok(`${c} on PATH`)
  else if (c === 'ollama') info(`${c} not found (optional, for local models)`)
  else bad(`${c} not found on PATH`)
}

const electronBin = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
if (!existsSync(electronBin)) bad(`Electron binary missing (${tilde(electronBin)}) — run \`npm run setup\``)
else {
  try { const v = execFileSync(electronBin, ['--version'], { timeout: 15_000 }).toString().trim(); ok(`Electron ${v} runs`) }
  catch (e) { bad(`Electron binary present but won't run: ${e.message}`) }
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) })
  const body = await res.json()
  if (body.root === ROOT) ok(`Server on :${PORT} is this checkout (pid ${body.pid})`)
  else bad(`Server on :${PORT} belongs to a DIFFERENT checkout: ${body.root} (pid ${body.pid}) — stop it before launching this one`)
} catch { info(`Nothing answering on :${PORT} (Mothership isn't running right now)`) }

existsSync(DATA) ? ok(`Data dir ${tilde(DATA)}`) : info(`Data dir ${tilde(DATA)} doesn't exist yet (created on first run)`)

info('Full Disk Access (for Apple Notes in search) can\'t be checked from here:')
info(`  System Settings → Privacy & Security → Full Disk Access → + → ${tilde(join(ROOT, 'node_modules/electron/dist/Electron.app'))}`)
