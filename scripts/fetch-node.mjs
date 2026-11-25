// Downloads the official Node binary that the packaged auto-m8.app runs its server on (Electron's own
// Node is too old: the server needs Node 26 for TypeScript type stripping and node:sqlite).
// Writes build/node/<arch>/node for each arch asked for (default: arm64 and x64), checked against
// nodejs.org's SHASUMS256. Used by `npm run dist`; dev installs never need it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = process.env.AUTO_M8_NODE_VERSION || 'v26.13.1'
const ROOT = join(import.meta.dirname, '..')
const archs = process.argv.slice(2).length ? process.argv.slice(2) : ['arm64', 'x64']

const get = async url => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
const sums = (await get(`https://nodejs.org/dist/${VERSION}/SHASUMS256.txt`)).toString()

for (const arch of archs) {
  const out = join(ROOT, 'build/node', arch)
  const stamp = join(out, 'VERSION')
  if (existsSync(join(out, 'node')) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === VERSION) { console.log(`node ${VERSION} ${arch}: cached`); continue }
  const name = `node-${VERSION}-darwin-${arch}.tar.gz`
  const want = sums.split('\n').find(l => l.endsWith(`  ${name}`))?.split(' ')[0]
  if (!want) throw new Error(`${name} is not in SHASUMS256.txt`)
  console.log(`node ${VERSION} ${arch}: downloading`)
  const tgz = await get(`https://nodejs.org/dist/${VERSION}/${name}`)
  const got = createHash('sha256').update(tgz).digest('hex')
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`)
  const tmp = mkdtempSync(join(tmpdir(), 'auto-m8-node-'))
  writeFileSync(join(tmp, name), tgz)
  execFileSync('tar', ['-xzf', join(tmp, name), '-C', tmp, `node-${VERSION}-darwin-${arch}/bin/node`])
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(join(tmp, `node-${VERSION}-darwin-${arch}/bin/node`), join(out, 'node'))
  chmodSync(join(out, 'node'), 0o755)
  writeFileSync(stamp, VERSION + '\n')
  rmSync(tmp, { recursive: true, force: true })
}
