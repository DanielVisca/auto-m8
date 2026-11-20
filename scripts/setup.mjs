// One-step install after cloning: `npm run setup` (add `-- --login` to also start perch when you log in).
// Checks what perch needs, installs and builds it, and puts a perch.app in ~/Applications that opens
// this checkout, so perch launches from Spotlight, Launchpad or the Dock like any app.
import { execFileSync, execSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(homedir(), 'Applications', 'perch.app')
const login = process.argv.includes('--login')
const say = (s) => console.log(`\x1b[1m▸\x1b[0m ${s}`)
const has = (cmd) => { try { execFileSync('/bin/zsh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' }); return true } catch { return false } }

if (process.platform !== 'darwin') { console.error('perch is a macOS app.'); process.exit(1) }

// What perch needs. Node 26+ runs the TypeScript server directly (type stripping, node:sqlite).
const major = Number(process.versions.node.split('.')[0])
if (major < 26) { console.error(`perch needs Node 26 or newer (this is ${process.version}). With Homebrew: brew install node`); process.exit(1) }
const missing = [['claude', 'Claude Code: https://docs.anthropic.com/claude-code (then run `claude` once to log in)'], ['gh', 'GitHub CLI: brew install gh (then gh auth login)']].filter(([c]) => !has(c))
for (const [, how] of missing) console.warn(`  ! missing ${how}`)
if (!has('ollama')) console.log('  (optional) Ollama for local models: https://ollama.com')

say('Installing dependencies')
execSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit' })
say('Building the interface')
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })

// perch.app: a tiny bundle whose only job is to open this checkout in perch's Electron.
say(`Creating ${APP.replace(homedir(), '~')}`)
rmSync(APP, { recursive: true, force: true })
mkdirSync(join(APP, 'Contents/MacOS'), { recursive: true })
mkdirSync(join(APP, 'Contents/Resources'), { recursive: true })
writeFileSync(join(APP, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>perch</string>
  <key>CFBundleDisplayName</key><string>perch</string>
  <key>CFBundleIdentifier</key><string>dev.perch.launcher</string>
  <key>CFBundleExecutable</key><string>perch</string>
  <key>CFBundleIconFile</key><string>perch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`)
// A login shell, so perch sees the same PATH as your terminal (node, claude, gh).
const launcher = join(APP, 'Contents/MacOS/perch')
writeFileSync(launcher, `#!/bin/zsh -l
# Opens perch from ${ROOT}. Re-run \`npm run setup\` there if you move the checkout.
# Opens perch, or repairs it first if it's stuck (scripts/open-or-repair.sh).
cd ${JSON.stringify(ROOT)} || exit 1
exec ${JSON.stringify(join(ROOT, 'scripts/open-or-repair.sh'))}
`)
chmodSync(launcher, 0o755)

// The icon, from the app's own artwork (sips and iconutil ship with macOS).
try {
  const src = join(ROOT, 'web/public/icon-180.png')
  const set = join(ROOT, 'node_modules/.perch.iconset')
  rmSync(set, { recursive: true, force: true }); mkdirSync(set)
  for (const s of [16, 32, 64, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), src, '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), src, '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(APP, 'Contents/Resources/perch.icns')])
  rmSync(set, { recursive: true, force: true })
} catch { console.warn('  (no icon: sips/iconutil failed; the app still works)') }

if (login) {
  say('Adding perch to your login items')
  try { execFileSync('osascript', ['-e', `tell application "System Events" to make login item at end with properties {path:${JSON.stringify(APP)}, hidden:false}`], { stdio: 'ignore' }) }
  catch { console.warn('  ! Could not add the login item (macOS asks for permission the first time). Add perch in System Settings → General → Login Items.') }
}

say('Done. Open perch from Spotlight (⌘Space, “perch”) or ~/Applications.')
console.log(`
First run:
  • perch uses your own logins: run \`claude\` and \`gh auth login\` once if you haven’t.
  • Apple Notes in search needs Full Disk Access for perch’s Electron:
    System Settings → Privacy & Security → Full Disk Access → + → ${join(ROOT, 'node_modules/electron/dist/Electron.app').replace(homedir(), '~')}
  • Show or hide the window anywhere with ⌃⌥Space.`)
