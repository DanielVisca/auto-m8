// Extracts the real macOS app icons for apps installed on this Mac into web/public/brand (gitignored),
// so Brand shows them locally without auto-m8 redistributing anyone's artwork. Missing apps keep
// their neutral glyph. Safe to re-run; macOS only (sips and defaults ship with it).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'web', 'public', 'brand')
const APPS = {
  claude: ['/Applications/Claude.app'],
  posthog: ['/Applications/PostHog.app'],
  slack: ['/Applications/Slack.app'],
  chrome: ['/Applications/Google Chrome.app'],
  cursor: ['/Applications/Cursor.app'],
  obsidian: ['/Applications/Obsidian.app'],
  vscode: ['/Applications/Visual Studio Code.app'],
  terminal: ['/System/Applications/Utilities/Terminal.app'],
  notes: ['/System/Applications/Notes.app'],
  finder: ['/System/Library/CoreServices/Finder.app'],
}

if (process.platform !== 'darwin') process.exit(0)
mkdirSync(OUT, { recursive: true })
let n = 0
for (const [id, paths] of Object.entries(APPS)) {
  const app = paths.find(p => existsSync(p))
  if (!app) continue
  try {
    let file = execFileSync('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleIconFile'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!file.endsWith('.icns')) file += '.icns'
    const src = join(app, 'Contents/Resources', file)
    if (!existsSync(src)) continue
    execFileSync('sips', ['-s', 'format', 'png', '-z', '64', '64', src, '--out', join(OUT, `${id}.png`)], { stdio: 'ignore' })
    n++
  } catch { /* keep the glyph for this one */ }
}
console.log(`  app icons: ${n} extracted to web/public/brand`)
