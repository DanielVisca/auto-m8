// Copy a skill to another profile (Work → Personal, or back). The skill comes from PostHog's skill
// store (fetched with this profile's key) or from one installed here; the other profile installs it
// into its own Claude skills folder, so every chat there can use it. Only the skill's files cross.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { skills } from './posthog.ts'
import { profile, profiles } from './profile.ts'
import { localSkills } from './search.ts'

type Bundle = { name: string; from: string; files: { path: string; content: string }[] }
const SAFE_NAME = /^[\w.-]{1,80}$/

function readDir(dir: string) {
  const files: Bundle['files'] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p) }
      else if (statSync(p).size < 2e6) files.push({ path: relative(dir, p), content: readFileSync(p, 'utf8') })
    }
  }
  walk(dir)
  return files
}

// The skill's files: installed here already, or fetched from the store.
export async function skillBundle(name: string): Promise<Bundle> {
  if (!SAFE_NAME.test(name)) throw new Error('That isn’t a skill name.')
  const local = localSkills().find(s => s.name === name)
  if (local?.path && existsSync(local.path)) return { name, from: profile.label, files: readDir(dirname(local.path)) }
  const tmp = mkdtempSync(join(tmpdir(), 'perch-skill-'))
  try {
    await skills.install(name, tmp)
    return { name, from: profile.label, files: readDir(join(tmp, name)) }
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export async function carrySkill(name: string, to: string) {
  const target = profiles().find(p => p.id === to)
  if (!target || target.id === profile.id) throw new Error('Pick another profile.')
  const bundle = await skillBundle(name)
  const r = await fetch(`http://127.0.0.1:${target.port}/api/skills/import`, { method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${target.port}` }, body: JSON.stringify(bundle) }).catch(() => null)
  if (!r?.ok) throw new Error(`${target.label} isn’t running. Turn it on from the profile switcher first.`)
  const out = await r.json() as any
  return { ...out, message: `${name} is installed in ${target.label} (${bundle.files.length} file${bundle.files.length === 1 ? '' : 's'}). New ${target.label} chats can use it.` }
}

// Receiving end: into this profile's own Claude skills folder.
export function importSkill(b: Bundle) {
  if (!SAFE_NAME.test(b.name) || !Array.isArray(b.files) || !b.files.some(f => f.path === 'SKILL.md')) throw new Error('That doesn’t look like a skill.')
  const dir = join(profile.claudeDir, 'skills', b.name)
  const replaced = existsSync(dir)
  rmSync(dir, { recursive: true, force: true })
  for (const f of b.files) {
    const safe = String(f.path).replace(/^\/+/, '')
    if (safe.split('/').includes('..')) continue
    mkdirSync(dirname(join(dir, safe)), { recursive: true })
    writeFileSync(join(dir, safe), f.content)
  }
  return { installed: dir, replaced, from: b.from }
}
