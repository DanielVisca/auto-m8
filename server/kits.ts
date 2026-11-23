// Kits (docs/kits.md): import someone's skills, routines and CLAUDE.md snippet, filled in with your own
// name and folders. Routines arrive switched off. Every item installed is recorded in kit_items, so a
// kit can be updated or removed without touching anything you changed after importing it.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { all, db, get, run } from './db.ts'
import { SAFE_NAME, VARS, type KitManifest, type KitRoutine } from './kitexport.ts'

db.exec(`
-- Kits: one row per item a kit installed. hash = what was installed, to tell untouched items from edited ones.
create table if not exists kit_items (
  kit text not null, version text, kind text not null,  -- skill | routine | instructions
  name text not null, ref text,                         -- skill folder, routine id, CLAUDE.md path
  hash text, installed_at integer,
  primary key (kit, kind, name)
);
`)

export type Values = Partial<Record<typeof VARS[number], string>>
export type Kit = { dir: string; manifest: KitManifest; routines: KitRoutine[]; instructions: string; cleanup: () => void }
export type PlanItem = { kind: 'skill' | 'routine' | 'instructions'; name: string; action: 'add' | 'update' | 'keep-yours' | 'unchanged'; note?: string; preview?: string }
export type Paths = { skillsDir: string; claudeMd: string; codeDir: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// A local folder or a git URL (cloned shallow into a temp folder).
export function openKit(src: string): Kit {
  let dir = src, cleanup = () => {}
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(src) || src.endsWith('.git')) {
    dir = mkdtempSync(join(tmpdir(), 'auto-m8-kit-'))
    cleanup = () => rmSync(dir, { recursive: true, force: true })
    try { execFileSync('git', ['clone', '--depth', '1', '--quiet', src, dir], { timeout: 60_000, stdio: 'pipe' }) }
    catch (e: any) { cleanup(); throw new Error(`Couldn’t clone ${src}: ${String(e.stderr || e.message).trim().slice(0, 300)}`) }
  }
  dir = resolve(dir)
  const mf = join(dir, 'kit.json')
  if (!existsSync(mf)) { cleanup(); throw new Error('Not a kit: no kit.json') }
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as KitManifest
  if (manifest.kit !== 1 || !SAFE_NAME.test(manifest.name ?? '')) { cleanup(); throw new Error('Not a kit this auto-m8 understands (kit.json)') }
  for (const s of manifest.skills ?? []) if (!SAFE_NAME.test(s) || !existsSync(join(dir, 'skills', s, 'SKILL.md'))) { cleanup(); throw new Error(`Kit skill "${s}" is missing or badly named`) }
  const routines: KitRoutine[] = existsSync(join(dir, 'routines.json')) ? JSON.parse(readFileSync(join(dir, 'routines.json'), 'utf8')) : []
  const instructions = manifest.instructions && existsSync(join(dir, 'instructions.md')) ? readFileSync(join(dir, 'instructions.md'), 'utf8') : ''
  return { dir, manifest: { ...manifest, skills: manifest.skills ?? [] }, routines, instructions, cleanup }
}

// {{var}} -> your value. A placeholder with no value stays visible so the preview shows what's missing.
export function render(text: string, v: Values) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (v as any)[k] || m)
}
export const missingVars = (text: string, v: Values) => [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]).filter(k => !(v as any)[k]))]

function skillFiles(kitDir: string, name: string) {
  const base = join(kitDir, 'skills', name), out: { path: string; content: string }[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && statSync(p).size < 2e6) out.push({ path: relative(base, p), content: readFileSync(p, 'utf8') })
    }
  }
  walk(base)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
const dirHash = (files: { path: string; content: string }[]) => sha(files.map(f => `${f.path}\0${f.content}`).join('\0'))
function installedHash(dir: string) {
  if (!existsSync(join(dir, 'SKILL.md'))) return null
  const out: { path: string; content: string }[] = []
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push({ path: relative(dir, p), content: readFileSync(p, 'utf8') }) } }
  walk(dir)
  return dirHash(out.sort((a, b) => a.path.localeCompare(b.path)))
}

const block = (kit: string, body: string) => `<!-- auto-m8-kit:${kit} -->\n${body.trim()}\n<!-- /auto-m8-kit:${kit} -->`
// Matches blocks written before the rename too (mothership-kit), so remove and re-import still find them.
const blockRe = (kit: string) => new RegExp(`\\n*<!-- (?:auto-m8|mothership)-kit:${kit.replace(/[.]/g, '\\.')} -->[\\s\\S]*?<!-- /(?:auto-m8|mothership)-kit:${kit.replace(/[.]/g, '\\.')} -->\\n?`)

type Ledger = { kit: string; kind: string; name: string; ref: string | null; hash: string | null; version: string | null }
const ledger = (kit: string) => all<Ledger>('select * from kit_items where kit = ?', kit)

// What importing would do, item by item. Nothing is written.
export function plan(k: Kit, v: Values, p: Paths): PlanItem[] {
  const mine = new Map(ledger(k.manifest.name).map(r => [`${r.kind}:${r.name}`, r]))
  const items: PlanItem[] = []
  for (const s of k.manifest.skills) {
    const files = skillFiles(k.dir, s).map(f => ({ ...f, content: render(f.content, v) }))
    const want = dirHash(files), have = installedHash(join(p.skillsDir, s)), rec = mine.get(`skill:${s}`)
    const missing = missingVars(files.map(f => f.content).join('\n'), v)
    const note = missing.length ? `needs ${missing.join(', ')}` : undefined
    const preview = files.find(f => f.path === 'SKILL.md')?.content.slice(0, 600)
    if (!have) items.push({ kind: 'skill', name: s, action: 'add', note, preview })
    else if (have === want) items.push({ kind: 'skill', name: s, action: 'unchanged' })
    else if (rec && rec.hash === have) items.push({ kind: 'skill', name: s, action: 'update', note, preview })
    else items.push({ kind: 'skill', name: s, action: 'keep-yours', note: rec ? 'you edited it since importing' : 'you already have a skill with this name' })
  }
  for (const r of k.routines) {
    const rec = mine.get(`routine:${r.name}`)
    const row = rec?.ref ? get<any>('select prompt, cron, mode from routines where id = ?', rec.ref) : null
    const prompt = render(r.prompt, v), h = sha(`${r.cron}\0${r.mode}\0${prompt}`)
    const missing = missingVars(prompt, v)
    const note = [r.cron ? `cron ${r.cron}, arrives switched off` : 'webhook only, arrives switched off', missing.length ? `needs ${missing.join(', ')}` : ''].filter(Boolean).join('; ')
    if (!row) items.push({ kind: 'routine', name: r.name, action: 'add', note, preview: prompt.slice(0, 600) })
    else if (sha(`${row.cron}\0${row.mode}\0${row.prompt}`) === h) items.push({ kind: 'routine', name: r.name, action: 'unchanged' })
    else if (sha(`${row.cron}\0${row.mode}\0${row.prompt}`) === rec!.hash) items.push({ kind: 'routine', name: r.name, action: 'update', note, preview: prompt.slice(0, 600) })
    else items.push({ kind: 'routine', name: r.name, action: 'keep-yours', note: 'you edited it since importing' })
  }
  if (k.instructions) {
    const cur = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : ''
    const body = render(k.instructions, v), m = cur.match(blockRe(k.manifest.name))
    items.push({ kind: 'instructions', name: 'CLAUDE.md', action: !m ? 'add' : m[0].trim() === block(k.manifest.name, body) ? 'unchanged' : 'update', note: `a marked section in ${p.claudeMd}`, preview: body.slice(0, 600) })
  }
  return items
}

// Applies the plan: adds and updates; never overwrites a skill or routine you changed.
export function apply(k: Kit, v: Values, p: Paths, only?: string[]): PlanItem[] {
  const items = plan(k, v, p).filter(i => !only || only.includes(`${i.kind}:${i.name}`))
  const kit = k.manifest.name, version = k.manifest.version, now = Date.now()
  const record = (kind: string, name: string, ref: string, hash: string) =>
    run(`insert into kit_items (kit, version, kind, name, ref, hash, installed_at) values (?, ?, ?, ?, ?, ?, ?)
         on conflict(kit, kind, name) do update set version = excluded.version, ref = excluded.ref, hash = excluded.hash, installed_at = excluded.installed_at`,
      kit, version, kind, name, ref, hash, now)
  for (const i of items) {
    if (i.action !== 'add' && i.action !== 'update') continue
    if (i.kind === 'skill') {
      const dest = join(p.skillsDir, i.name)
      if (!resolve(dest).startsWith(resolve(p.skillsDir) + sep)) continue
      rmSync(dest, { recursive: true, force: true })
      const files = skillFiles(k.dir, i.name).map(f => ({ ...f, content: render(f.content, v) }))
      for (const f of files) {
        const out = resolve(dest, f.path)
        if (!out.startsWith(resolve(dest) + sep)) continue // a kit can't write outside its skill folder
        mkdirSync(join(out, '..'), { recursive: true }); writeFileSync(out, f.content)
      }
      record('skill', i.name, dest, dirHash(files))
    } else if (i.kind === 'routine') {
      const r = k.routines.find(x => x.name === i.name)!
      const prompt = render(r.prompt, v), mode = r.mode === 'fresh' ? 'fresh' : 'resume'
      const prev = ledger(kit).find(x => x.kind === 'routine' && x.name === i.name)?.ref
      const id = prev && get('select id from routines where id = ?', prev) ? prev : randomUUID()
      if (id === prev) run('update routines set prompt = ?, cron = ?, mode = ? where id = ?', prompt, r.cron, mode, id)
      else run(`insert into routines (id, name, prompt, cwd, cron, webhook_secret, mode, enabled, created_at) values (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        id, render(r.name, v), prompt, p.codeDir, r.cron, randomBytes(16).toString('hex'), mode, now)
      record('routine', i.name, id, sha(`${r.cron}\0${mode}\0${prompt}`))
    } else {
      const cur = existsSync(p.claudeMd) ? readFileSync(p.claudeMd, 'utf8') : ''
      const b = block(kit, render(k.instructions, v))
      const next = blockRe(kit).test(cur) ? cur.replace(blockRe(kit), `\n\n${b}\n`) : `${cur.trimEnd()}${cur.trim() ? '\n\n' : ''}${b}\n`
      mkdirSync(join(p.claudeMd, '..'), { recursive: true }); writeFileSync(p.claudeMd, next)
      record('instructions', 'CLAUDE.md', p.claudeMd, sha(b))
    }
  }
  return items
}

export function installed() {
  return all<{ kit: string; version: string; items: number; installed_at: number }>(
    'select kit, max(version) version, count(*) items, max(installed_at) installed_at from kit_items group by kit order by kit')
}

// Removes what the kit installed. Skills you edited since stay (listed in kept).
export function remove(kit: string, p: Pick<Paths, 'claudeMd'>) {
  const removed: string[] = [], kept: string[] = []
  for (const r of ledger(kit)) {
    if (r.kind === 'skill' && r.ref) {
      if (installedHash(r.ref) === r.hash) { rmSync(r.ref, { recursive: true, force: true }); removed.push(`skill:${r.name}`) }
      else if (existsSync(r.ref)) kept.push(`skill:${r.name}`)
    } else if (r.kind === 'routine' && r.ref) { run('delete from routines where id = ?', r.ref); removed.push(`routine:${r.name}`) }
    else if (r.kind === 'instructions') {
      const f = r.ref ?? p.claudeMd
      if (existsSync(f)) { writeFileSync(f, readFileSync(f, 'utf8').replace(blockRe(kit), '\n')); removed.push('instructions:CLAUDE.md') }
    }
  }
  run('delete from kit_items where kit = ?', kit)
  return { removed, kept }
}

// The importer's own values, from auto-m8's settings.
export async function myValues(): Promise<{ values: Values; paths: Paths }> {
  const { settings } = await import('./settings.ts')
  const { ownerName } = await import('./owner.ts')
  const home = homedir()
  // Your first GitHub org, for kits that scope PR searches to one (gh search prs --owner=...).
  let org = process.env.PERCH_GITHUB_ORG ?? ''
  if (!org) try { org = execFileSync('gh', ['api', 'user/orgs', '--jq', '.[0].login'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  return {
    values: { 'owner.name': ownerName(), home, codeDir: settings.chat.cwd || home, ...(org ? { 'github.org': org } : {}), ...(settings.posthog?.projectId ? { 'posthog.projectId': String(settings.posthog.projectId) } : {}) },
    paths: { skillsDir: join(home, '.claude/skills'), claudeMd: join(home, '.claude/CLAUDE.md'), codeDir: settings.chat.cwd || home },
  }
}
