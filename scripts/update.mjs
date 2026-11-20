// `npm run update`: pull the latest commits, reinstall, rebuild, then restart Mothership the same
// safe way the Dock icon repairs a stuck one (TERM, then KILL, then relaunch, then wait for
// health) - a healthy OLD build must not be left running just because it still answers.
import { execFileSync, execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const say = (s) => console.log(`\x1b[1m▸\x1b[0m ${s}`)
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const dirty = git(['status', '--porcelain'])
if (dirty) {
  console.error('Uncommitted changes in this checkout — commit or stash before updating:\n')
  console.error(dirty)
  process.exit(1)
}

say('Fetching latest')
git(['fetch', 'origin'])
let behind
try { behind = git(['rev-list', '--count', 'HEAD..@{u}']) }
catch { console.error("No upstream branch tracked here - can't tell if there's anything to pull."); process.exit(1) }
if (behind === '0') { say('Already up to date.'); process.exit(0) }

say(`${behind} commit(s) behind — pulling`)
sh('git pull --ff-only')
say('Installing dependencies')
sh('npm install --no-audit --no-fund')
say('Building the interface')
sh('npm run build')
say('Restarting Mothership with the new build')
sh(`${JSON.stringify(join(ROOT, 'scripts/open-or-repair.sh'))} --restart`)
