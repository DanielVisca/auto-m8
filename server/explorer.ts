// Architecture explorer: a map of a repo you can trust. Every concept, edge, date and author comes from
// the files and the git history (each with a file:line or a commit behind it); AI only explains on top of it,
// in a chat that's handed this evidence. Works on any repo: concepts are module folders found by
// generic rules, edges are imports and ORM foreign keys between them.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Evidence = { file: string; line: number; text: string }
export type Relation = { model: string; target: string; kind: 'fk' | 'o2o' | 'm2m'; file: string; line: number }
export type Concept = { id: string; name: string; path: string; files: number; models: string[]; relations: Relation[] }
export type Edge = { from: string; to: string; kind: 'fk' | 'import'; weight: number; evidence: Evidence[] }
export type Graph = { repo: string; sha: string; concepts: Concept[]; edges: Edge[]; models: Record<string, { concept: string; file: string; line: number }> }
export type FocusNode = Concept & { role: 'focus' | 'dependency' | 'dependent' | 'both' | 'second'; score: number; hub: boolean }
export type FocusGraph = { repo: string; sha: string; focus: string | null; nodes: FocusNode[]; edges: Edge[]; hidden: { dependencies: number; dependents: number; second: number; hubs: string[] }; total: number }

// Folders whose children are the modules of a codebase. Deepest match wins, so posthog/models/x beats posthog/x.
// A repo can override with .explorer.json { "containers": [...] }.
const CONTAINERS = ['products', 'packages', 'apps', 'services', 'libs', 'lib', 'modules', 'crates', 'plugins', 'cmd', 'internal', 'pkg', 'src', 'ee', 'rust', 'common',
  'frontend/src/scenes', 'frontend/src/lib', 'frontend/src/queries', 'posthog', 'posthog/models', 'posthog/api', 'nodejs/src', 'plugin-server/src']
const SRC = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs)$/
// Tests, stories and generated files aren't architecture: they'd make every module look coupled to everything it tests.
const SKIP = /(^|\/)(tests?|__tests__|__snapshots__|__mocks__|migrations|fixtures|node_modules|dist|build|vendor|generated)\/|\.(test|spec|stories)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.d\.ts$|Type\.ts$/
const MODEL_FILE = /(^|\/)models(\/|\.py$)/
const GENERIC = new Set(['api', 'apis', 'models', 'utils', 'util', 'lib', 'libs', 'common', 'core', 'src', 'frontend', 'backend', 'test', 'tests', 'scripts', 'bin', 'docs', 'internal', 'pkg', 'cmd', 'shared', 'helpers', 'components', 'types', 'config', 'settings', 'misc', 'node', 'nodes', 'query', 'queries', 'data', 'cache', 'caching', 'hooks', 'logic', 'schema', 'ui', 'web', 'max', 'product analytics', 'introductions'])

export function containersFor(repo: string): string[] {
  try { const c = JSON.parse(readFileSync(join(repo, '.explorer.json'), 'utf8')).containers; if (Array.isArray(c) && c.length) return c.map(String) } catch {}
  return CONTAINERS
}

// The module a path belongs to: <container>/<child> when the path goes deeper than that child, else its top folder.
export function conceptOf(path: string, containers: string[]): string {
  const segs = path.split('/')
  let best: string | null = null, depth = -1
  for (const c of containers) {
    const cs = c.split('/')
    if (cs.length > depth && segs.length >= cs.length + 2 && cs.every((s, i) => segs[i] === s)) { best = segs.slice(0, cs.length + 1).join('/'); depth = cs.length }
  }
  return best ?? (segs.length > 1 ? segs[0] : '(root)')
}

const git = (repo: string, args: string[], timeout = 30_000) => new Promise<string>((res, rej) =>
  execFile('git', ['-C', repo, ...args], { maxBuffer: 256 << 20, timeout }, (e, out) => e ? rej(e) : res(out)))
const gh = (args: string[], timeout = 20_000) => new Promise<string>((res, rej) =>
  execFile('gh', args, { maxBuffer: 32 << 20, timeout }, (e, out) => e ? rej(e) : res(out)))

// Only real repos the user owns, by their top level: the explorer runs git and reads every file in it.
export async function checkRepo(path: string, home = homedir()): Promise<string> {
  if (!path || !existsSync(path)) throw new Error('No such folder')
  const real = realpathSync(path), h = realpathSync(home)
  if (real !== h && !real.startsWith(h + sep)) throw new Error('Repo must be inside your home folder')
  let top: string
  try { top = (await git(real, ['rev-parse', '--show-toplevel'], 5000)).trim() } catch { throw new Error('Not a git repository') }
  return realpathSync(top)
}

// ---------- scan: concepts and edges from the files ----------

type ImportRef = { spec: string; line: number; text: string; names?: string[]; lang: 'py' | 'js' | 'go' | 'rs' }

export function importsOf(file: string, src: string): ImportRef[] {
  const lang = file.endsWith('.py') ? 'py' : file.endsWith('.go') ? 'go' : file.endsWith('.rs') ? 'rs' : 'js'
  const out: ImportRef[] = []
  const lines = src.split('\n')
  let goBlock = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], t = l.trim().slice(0, 300)
    if (lang === 'py') {
      let m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.*)$/.exec(l)
      if (m) {
        let names = m[2]
        // from x import (\n a,\n b\n)
        if (names.includes('(') && !names.includes(')')) for (let j = i + 1; j < lines.length && j < i + 80; j++) { names += lines[j]; if (lines[j].includes(')')) break }
        out.push({ spec: m[1], line: i + 1, text: t, lang, names: names.replace(/[()]/g, '').split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(n => /^\w+$/.test(n)) })
        continue
      }
      m = /^\s*import\s+([\w.]+)/.exec(l)
      if (m) out.push({ spec: m[1], line: i + 1, text: t, lang })
    } else if (lang === 'go') {
      if (/^\s*import\s*\($/.test(l)) { goBlock = true; continue }
      if (goBlock && /^\s*\)/.test(l)) { goBlock = false; continue }
      const m = (goBlock ? /^\s*(?:\w+\s+)?"([^"]+)"/ : /^\s*import\s+(?:\w+\s+)?"([^"]+)"/).exec(l)
      if (m) out.push({ spec: m[1], line: i + 1, text: t, lang })
    } else if (lang === 'rs') {
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use|extern\s+crate)\s+([\w:]+)/.exec(l)
      if (m && !/^(crate|self|super|std|core|alloc)\b/.test(m[1])) out.push({ spec: m[1], line: i + 1, text: t, lang })
    } else {
      const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(l))) out.push({ spec: m[1] ?? m[2] ?? m[3] ?? m[4], line: i + 1, text: t, lang })
    }
  }
  return out
}

type Resolver = (file: string, ref: ImportRef) => string | null
function makeResolver(concepts: Set<string>, tops: Set<string>, containers: string[]): Resolver {
  // Workspace aliases (scenes/x, lib/x, ~/x, crate names) are matched against the tail of each module's path.
  const byTail2 = new Map<string, string>(), byTail1 = new Map<string, string | null>()
  const norm = (s: string) => s.toLowerCase().replace(/-/g, '_')
  for (const c of concepts) {
    const s = c.split('/')
    if (s.length >= 2) byTail2.set(norm(s.slice(-2).join('/')), c)
    const k = norm(s[s.length - 1]); byTail1.set(k, byTail1.has(k) ? null : c) // ambiguous names never match
  }
  const known = (p: string) => { const c = conceptOf(p + '/_', containers); return concepts.has(c) ? c : null }
  return (file, ref) => {
    const dir = posix.dirname(file)
    let spec = ref.spec
    if (ref.lang === 'py') {
      if (spec.startsWith('.')) { const dots = /^\.+/.exec(spec)![0].length; let d = dir; for (let k = 1; k < dots; k++) d = posix.dirname(d); return known(posix.join(d, spec.slice(dots).replace(/\./g, '/'))) }
      const p = spec.replace(/\./g, '/')
      return tops.has(p.split('/')[0]) ? known(p) : null
    }
    if (ref.lang === 'js' && spec.startsWith('.')) return known(posix.join(dir, spec))
    spec = spec.replace(/^~\//, '').replace(/^@[\w-]+\//, '').replace(/::/g, '/')
    if (ref.lang === 'go') { const s = spec.split('/'); for (let k = 0; k < s.length; k++) { const c = tops.has(s[k]) ? known(s.slice(k).join('/')) : null; if (c) return c } }
    if (tops.has(spec.split('/')[0])) { const c = known(spec); if (c) return c }
    const s = spec.split('/')
    if (s.length >= 2) { const c = byTail2.get(norm(s.slice(0, 2).join('/'))); if (c) return c }
    if (ref.lang === 'rs' || ref.lang === 'go' || ref.spec.startsWith('@')) { const c = byTail1.get(norm(s[0])); if (c) return c }
    return null
  }
}

const MAX_EVIDENCE = 5
export async function scan(repo: string, sha?: string): Promise<Graph> {
  const containers = containersFor(repo)
  const files = (await git(repo, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const conceptFiles = new Map<string, number>()
  for (const f of files) { const c = conceptOf(f, containers); conceptFiles.set(c, (conceptFiles.get(c) ?? 0) + 1) }
  const ids = new Set(conceptFiles.keys())
  const tops = new Set(files.filter(f => f.includes('/')).map(f => f.split('/')[0]))
  const src = files.filter(f => SRC.test(f) && !SKIP.test(f))
  const read = async (f: string) => { try { const s = await stat(join(repo, f)); return s.size > 400_000 ? '' : await readFile(join(repo, f), 'utf8') } catch { return '' } }
  const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => { const out: R[] = new Array(xs.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]) } })); return out }

  // Pass 1: ORM models (Django-style), so `from posthog.models import Insight` lands on the module that defines Insight.
  const models: Graph['models'] = {}, dup = new Set<string>()
  const relations = new Map<string, Relation[]>()
  const modelFiles = src.filter(f => f.endsWith('.py') && MODEL_FILE.test(f))
  const modelSrc = new Map<string, string>()
  await pool(modelFiles, 32, async f => { modelSrc.set(f, await read(f)) })
  for (const f of modelFiles) {
    const lines = modelSrc.get(f)!.split('\n')
    lines.forEach((l, i) => {
      const m = /^class (\w+)\(([^)]*)\)\s*:/.exec(l)
      if (!m || m[1].startsWith('_') || !m[2].trim() || /Choices|Enum|Exception|Error|Protocol|TypedDict|NamedTuple|Serializer|Admin|Test|Config\b|Mixin\)$/.test(m[2]) || /Mixin$|Manager$|QuerySet$|Choices$/.test(m[1])) return
      if (!/models\.|Model\b|Model\)|Model,/.test(m[2]) && !/models\.(\w*Field|ForeignKey)/.test(lines.slice(i + 1, i + 40).join('\n'))) return
      if (models[m[1]]) dup.add(m[1]); else models[m[1]] = { concept: conceptOf(f, containers), file: f, line: i + 1 }
    })
  }
  for (const d of dup) delete models[d] // a name defined twice can't be resolved by name
  const edges = new Map<string, Edge>()
  const addEdge = (from: string, to: string, kind: Edge['kind'], ev: Evidence) => {
    if (from === to) return
    const k = `${from}\t${to}\t${kind}`
    const e = edges.get(k) ?? edges.set(k, { from, to, kind, weight: 0, evidence: [] }).get(k)!
    e.weight++
    if (e.evidence.length < MAX_EVIDENCE) e.evidence.push(ev)
  }
  for (const f of modelFiles) {
    const lines = modelSrc.get(f)!.split('\n')
    let cls: string | null = null
    lines.forEach((l, i) => {
      const c = /^class (\w+)\(/.exec(l); if (c) { cls = models[c[1]] ? c[1] : null; return }
      if (!cls || !/^\s/.test(l)) { if (/^\S/.test(l)) cls = null; return }
      const m = /(ForeignKey|OneToOneField|ManyToManyField)\(\s*(?:to\s*=\s*)?["']?([\w.]+)["']?/.exec(l + ' ' + (lines[i + 1] ?? '').trim())
      if (!m) return
      const target = m[2].split('.').pop()!
      if (target === 'self' || !models[target]) return
      const kind = m[1] === 'ForeignKey' ? 'fk' : m[1] === 'OneToOneField' ? 'o2o' : 'm2m'
      const from = models[cls].concept, to = models[target].concept
      const rel = { model: cls, target, kind, file: f, line: i + 1 } as Relation
      relations.set(from, [...(relations.get(from) ?? []), rel])
      addEdge(from, to, 'fk', { file: f, line: i + 1, text: `${cls} → ${target}: ${l.trim().slice(0, 200)}` })
    })
  }

  // Pass 2: imports between modules (one count per importing file, so a chatty file doesn't outweigh many).
  const resolve = makeResolver(ids, tops, containers)
  await pool(src, 64, async f => {
    const text = modelSrc.get(f) ?? await read(f)
    if (!text) return
    const from = conceptOf(f, containers)
    const seen = new Set<string>()
    for (const ref of importsOf(f, text)) {
      let targets = [resolve(f, ref)]
      // Re-exported models: attribute the import to wherever the model really lives.
      if (ref.names?.length) { const m = ref.names.map(n => models[n]?.concept).filter(Boolean) as string[]; if (m.length) targets = m }
      for (const to of targets) {
        if (!to || to === from || seen.has(to)) continue
        seen.add(to)
        addEdge(from, to, 'import', { file: f, line: ref.line, text: ref.text })
      }
    }
  })
  const modelsBy = new Map<string, string[]>()
  for (const [n, m] of Object.entries(models)) modelsBy.set(m.concept, [...(modelsBy.get(m.concept) ?? []), n])
  const concepts: Concept[] = [...conceptFiles].map(([id, n]) => ({ id, name: id.split('/').pop()!, path: id, files: n, models: (modelsBy.get(id) ?? []).sort(), relations: relations.get(id) ?? [] }))
  return { repo, sha: sha ?? (await git(repo, ['rev-parse', 'HEAD'])).trim(), concepts, edges: [...edges.values()], models }
}

// ---------- focus: a readable slice instead of the whole hairball ----------

const stem = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/(ies)$/, 'y').replace(/s$/, '')
export function focusGraph(g: Graph, focus?: string | null, cap = 25, showHubs = false): FocusGraph {
  const byId = new Map(g.concepts.map(c => [c.id, c]))
  // Modules almost everything depends on (the Team model, a shared api folder) are plumbing, not what this concept is
  // built on: rank neighbours by weight × rarity so they don't crowd out the relationships that are specific to it.
  const dependents = new Map<string, Set<string>>()
  for (const e of g.edges) (dependents.get(e.to) ?? dependents.set(e.to, new Set()).get(e.to)!).add(e.from)
  const N = Math.max(2, g.concepts.length)
  const rarity = (id: string) => Math.log(N / (1 + (dependents.get(id)?.size ?? 0))) / Math.log(N) + 0.05
  const hub = (id: string) => (dependents.get(id)?.size ?? 0) > Math.max(8, N * 0.15)
  const ew = (e: Edge) => e.weight * (e.kind === 'fk' ? 5 : 1) // a foreign key is a data dependency: much harder to remove than an import
  const node = (c: Concept, role: FocusNode['role'], score: number): FocusNode => ({ ...c, role, score: Math.round(score * 100) / 100, hub: hub(c.id) })

  if (!focus?.trim()) {
    const deg = new Map<string, number>()
    for (const e of g.edges) { deg.set(e.from, (deg.get(e.from) ?? 0) + ew(e)); deg.set(e.to, (deg.get(e.to) ?? 0) + ew(e)) }
    if (!showHubs) for (const id of [...deg.keys()]) if (hub(id)) deg.delete(id)
    const top = [...deg].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([id, s]) => node(byId.get(id)!, 'second', s))
    const keep = new Set(top.map(n => n.id))
    return { repo: g.repo, sha: g.sha, focus: null, nodes: top, edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)), hidden: { dependencies: 0, dependents: 0, second: g.concepts.length - top.length, hubs: [] }, total: g.concepts.length }
  }
  const q = stem(focus)
  const match = (c: Concept) => { const n = stem(c.name); return n === q ? 3 : c.models.some(m => stem(m) === q) ? 2.5 : n.includes(q) ? 2 : c.models.some(m => stem(m).startsWith(q)) ? 1 : 0 }
  // An exact module path or model name (what "Focus here" sends) means that one concept, not a search.
  const exact = byId.get(focus.trim()) ?? byId.get(g.models[focus.trim()]?.concept ?? '')
  const scored = exact ? [[exact, 9] as const] : g.concepts.map(c => [c, match(c)] as const).filter(([, s]) => s > 0)
  // A weak match (a model that merely starts with the word) only counts when nothing matches by name.
  const strong = scored.some(([, s]) => s >= 2)
  const focused = scored.filter(([, s]) => !strong || s >= 2).sort((a, b) => b[1] - a[1] || b[0].files - a[0].files).slice(0, 5).map(([c]) => c)
  const F = new Set(focused.map(c => c.id))
  const deps = new Map<string, number>(), users = new Map<string, number>()
  // Shared foundations (UI kit, the Team model) are listed by name instead of drawn: they connect to everything.
  const hubs = new Set<string>()
  for (const e of g.edges) {
    const other = F.has(e.from) ? e.to : F.has(e.to) ? e.from : null
    if (!showHubs && other && !F.has(other) && hub(other)) { hubs.add(other); continue }
    if (F.has(e.from) && !F.has(e.to)) deps.set(e.to, (deps.get(e.to) ?? 0) + ew(e) * rarity(e.to))
    if (F.has(e.to) && !F.has(e.from)) users.set(e.from, (users.get(e.from) ?? 0) + ew(e) * rarity(e.from))
  }
  const room = Math.max(0, cap - F.size)
  const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])
  // Split the room between what it's built on and what's built on it, so neither side drowns the other.
  const rd = rank(deps), ru = rank(users)
  const half = Math.ceil(room * 0.5)
  let nd = Math.min(rd.length, half), nu = Math.min(ru.length, room - nd)
  nd = Math.min(rd.length, room - nu)
  const picked = new Map<string, FocusNode>()
  for (const c of focused) picked.set(c.id, node(c, 'focus', 0))
  for (const [id, s] of rd.slice(0, nd)) picked.set(id, node(byId.get(id)!, users.has(id) ? 'both' : 'dependency', s))
  for (const [id, s] of ru.slice(0, nu)) if (!picked.has(id)) picked.set(id, node(byId.get(id)!, deps.has(id) ? 'both' : 'dependent', s))
  // Second hop only for strong links, and only if there's room left.
  let second = 0
  if (picked.size < cap) {
    const cand = new Map<string, number>()
    for (const e of g.edges) {
      const [a, b] = picked.has(e.from) && !picked.has(e.to) ? [e.from, e.to] : picked.has(e.to) && !picked.has(e.from) ? [e.to, e.from] : [null, null]
      // Never hop through plumbing, and score by the share of the neighbour's links, so huge modules don't win on size.
      if (a && picked.get(a)!.role !== 'focus' && !hub(a) && e.weight >= 5 && !hub(b!)) cand.set(b!, (cand.get(b!) ?? 0) + e.weight * rarity(b!) / Math.sqrt(byId.get(b!)!.files))
    }
    const r = rank(cand)
    const n = Math.min(r.length, cap - picked.size, 4)
    for (const [id, s] of r.slice(0, n)) picked.set(id, node(byId.get(id)!, 'second', s))
    second = r.length - n
  }
  const keep = new Set(picked.keys())
  return {
    repo: g.repo, sha: g.sha, focus, nodes: [...picked.values()],
    edges: g.edges.filter(e => keep.has(e.from) && keep.has(e.to)),
    hidden: { dependencies: [...deps.keys()].filter(k => !keep.has(k)).length, dependents: [...users.keys()].filter(k => !keep.has(k)).length, second, hubs: [...hubs].sort() },
    total: g.concepts.length,
  }
}

// ---------- dream: what if we removed X, or added Y attached to a, b ----------

export type DreamOp = { op: 'remove'; id: string } | { op: 'add'; id: string; name?: string; dependsOn?: string[]; usedBy?: string[] }
export type DreamResult = {
  removed: string[]; added: { id: string; name: string }[]
  broken: { id: string; loses: { to: string; kind: Edge['kind']; weight: number }[] }[]
  affected: { id: string; depth: number; via: string }[]
  orphaned: string[]; edgesRemoved: Edge[]; edgesAdded: Edge[]; warnings: string[]; summary: string
}
export function dream(g: { concepts: { id: string }[]; edges: Edge[] }, ops: DreamOp[]): DreamResult {
  const exists = new Set(g.concepts.map(c => c.id))
  const removed = new Set<string>(), added: DreamResult['added'] = [], edgesAdded: Edge[] = [], warnings: string[] = []
  for (const o of ops) if (o.op === 'remove') { if (exists.has(o.id)) removed.add(o.id); else warnings.push(`${o.id} isn't in the graph`) }
  for (const o of ops) if (o.op === 'add') {
    added.push({ id: o.id, name: o.name ?? o.id })
    for (const d of o.dependsOn ?? []) { if (removed.has(d)) warnings.push(`${o.id} depends on ${d}, which this dream removes`); edgesAdded.push({ from: o.id, to: d, kind: 'import', weight: 1, evidence: [] }) }
    for (const u of o.usedBy ?? []) { if (removed.has(u)) warnings.push(`${u} would use ${o.id}, but this dream removes it`); edgesAdded.push({ from: u, to: o.id, kind: 'import', weight: 1, evidence: [] }) }
  }
  const edgesRemoved = g.edges.filter(e => removed.has(e.from) || removed.has(e.to))
  const kept = g.edges.filter(e => !removed.has(e.from) && !removed.has(e.to)).concat(edgesAdded.filter(e => !removed.has(e.from) && !removed.has(e.to)))
  // Broken: directly depends on something removed (needs rework). Affected: depends on something broken, a few hops out.
  const brokenMap = new Map<string, DreamResult['broken'][0]['loses']>()
  for (const e of g.edges) if (removed.has(e.to) && !removed.has(e.from)) (brokenMap.get(e.from) ?? brokenMap.set(e.from, []).get(e.from)!).push({ to: e.to, kind: e.kind, weight: e.weight })
  // Hardest hit first: foreign keys count five times an import, like in the focus ranking.
  const cost = (l: { kind: string; weight: number }[]) => l.reduce((n, x) => n + x.weight * (x.kind === 'fk' ? 5 : 1), 0)
  const broken = [...brokenMap].map(([id, loses]) => ({ id, loses: loses.sort((a, b) => b.weight - a.weight) })).sort((a, b) => cost(b.loses) - cost(a.loses) || a.id.localeCompare(b.id))
  const affected: DreamResult['affected'] = [], seen = new Set([...removed, ...brokenMap.keys()])
  let frontier = [...brokenMap.keys()]
  for (let depth = 2; depth <= 2 && frontier.length; depth++) { // one hop further: past that, everything is 'affected'
    const next: string[] = []
    for (const e of kept) if (frontier.includes(e.to) && !seen.has(e.from)) { seen.add(e.from); next.push(e.from); affected.push({ id: e.from, depth, via: e.to }) }
    frontier = next
  }
  // Orphaned: had connections before, none after (nothing uses it and it uses nothing).
  const touched = new Set(kept.flatMap(e => [e.from, e.to]))
  const before = new Set(g.edges.flatMap(e => [e.from, e.to]))
  const orphaned = [...before].filter(id => !removed.has(id) && !touched.has(id)).sort()
  affected.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const summary = [
    removed.size ? `Removing ${[...removed].join(', ')} cuts ${edgesRemoved.length} dependency link${edgesRemoved.length === 1 ? '' : 's'}.` : '',
    broken.length ? `${broken.length} module${broken.length === 1 ? '' : 's'} built directly on it would need rework, hardest hit first${broken.some(b => b.loses.some(l => l.kind === 'fk')) ? ' (some through database foreign keys, the hardest kind to untangle)' : ''}: ${broken.slice(0, 6).map(b => b.id).join(', ')}${broken.length > 6 ? '…' : ''}.` : '',
    affected.length ? `${affected.length} more build on those.` : '',
    orphaned.length ? `${orphaned.length} would be left with no connections.` : '',
    added.length ? `Adding ${added.map(a => a.name).join(', ')} with ${edgesAdded.length} link${edgesAdded.length === 1 ? '' : 's'}.` : '',
    ...warnings,
  ].filter(Boolean).join(' ')
  return { removed: [...removed], added, broken, affected, orphaned, edgesRemoved, edgesAdded, warnings, summary: summary || 'No change.' }
}

// ---------- timeline: when each concept and link appeared, and who did it ----------

export type Commit = { sha: string; date: string; author: string; subject: string; pr: number | null; url: string | null }
export type TimelineEvent = { date: string; kind: 'concept' | 'edge'; id: string; from?: string; to?: string; approx: boolean; source: string; commit: Commit }
export type Timeline = { status: 'running' | 'done'; done: number; total: number; source: string; shallow: boolean; since: string | null; events: TimelineEvent[]; milestones: Record<string, Commit[]>; error?: string }

export const prOf = (subject: string) => { const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /Merge pull request #(\d+)/.exec(subject); return m ? Number(m[1]) : null }
export async function remoteOf(repo: string): Promise<{ owner: string; name: string } | null> {
  try { const u = (await git(repo, ['remote', 'get-url', 'origin'], 5000)).trim(); const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(u); return m ? { owner: m[1], name: m[2] } : null } catch { return null }
}
export const ghUrl = (r: { owner: string; name: string } | null, kind: 'blob' | 'commit' | 'pr' | 'tree', a: string | number, path?: string, line?: number) =>
  !r ? null : kind === 'pr' ? `https://github.com/${r.owner}/${r.name}/pull/${a}` : kind === 'commit' ? `https://github.com/${r.owner}/${r.name}/commit/${a}` : `https://github.com/${r.owner}/${r.name}/${kind}/${a}/${path ?? ''}${line ? `#L${line}` : ''}`

const FMT = '%H%x1f%aI%x1f%an%x1f%s'
const parseLog = (out: string, r: Awaited<ReturnType<typeof remoteOf>>): Commit[] => out.split('\n').filter(l => l.includes('\x1f')).map(l => {
  const [sha, date, author, subject] = l.split('\x1f'); const pr = prOf(subject)
  return { sha, date, author, subject, pr, url: pr ? ghUrl(r, 'pr', pr) : ghUrl(r, 'commit', sha) }
})

export async function localFirst(repo: string, path: string, r: Awaited<ReturnType<typeof remoteOf>>) {
  const c = parseLog(await git(repo, ['log', '--diff-filter=A', '--reverse', `--format=${FMT}`, '--', path], 20_000), r)
  return c[0] ?? null
}
async function localMention(repo: string, term: string, r: Awaited<ReturnType<typeof remoteOf>>) {
  const c = parseLog(await git(repo, ['log', '--reverse', '-i', `--grep=${term}`, `--format=${FMT}`], 20_000), r)
  return c.find(x => namesIt(x.subject, term)) ?? null
}
async function localPickaxe(repo: string, text: string, file: string, r: Awaited<ReturnType<typeof remoteOf>>) {
  const c = parseLog(await git(repo, ['log', '--reverse', `-S${text}`, `--format=${FMT}`, '--', file], 15_000), r)
  return c[0] ?? null
}
// Shallow clones don't know the past, so ask GitHub: the oldest commit on the path (it only knows the current
// path, so a module that moved shows when it moved) and the oldest commit message that names the concept.
async function ghFirst(r: { owner: string; name: string }, path: string): Promise<Commit | null> {
  const base = `repos/${r.owner}/${r.name}/commits?path=${encodeURIComponent(path)}&per_page=1`
  const head = await gh(['api', '-i', base])
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(head)?.[1]
  const body = last ? await gh(['api', `${base}&page=${last}`]) : head.slice(head.indexOf('\r\n\r\n') + 4 || head.indexOf('\n\n') + 2)
  const c = JSON.parse(body)?.[0]
  return c ? ghCommit(r, c) : null
}
// Search matches anywhere in the message, so keep only commits whose subject names the concept as a word.
export const namesIt = (subject: string, term: string) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?\\b`, 'i').test(subject)
async function ghMention(r: { owner: string; name: string }, term: string): Promise<Commit | null> {
  const items = JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', `search/commits?q=${encodeURIComponent(`repo:${r.owner}/${r.name} "${term}"`)}&sort=author-date&order=asc&per_page=30`]))?.items ?? []
  const c = items.find((c: any) => namesIt(String(c.commit?.message ?? '').split('\n')[0], term))
  return c ? ghCommit(r, c) : null
}
function ghCommit(r: { owner: string; name: string }, c: any): Commit {
  const subject = String(c.commit?.message ?? '').split('\n')[0], pr = prOf(subject)
  return { sha: c.sha, date: c.commit?.author?.date ?? '', author: c.commit?.author?.name ?? c.author?.login ?? '', subject, pr, url: pr ? ghUrl(r, 'pr', pr) : ghUrl(r, 'commit', c.sha) }
}
// GitHub blame: the commit that last wrote a line, even before a shallow clone's cut-off (it follows renames).
// One GraphQL query per file at one commit, cached; the PR comes from the "(#123)" in the subject, because
// asking GitHub for the PR as well pushes blame on a big repo past its 10s query limit.
type Blame = { start: number; end: number; c: Commit }[]
const blameCache = new Map<string, Promise<{ lines: string[]; ranges: Blame } | null>>()
function ghBlame(r: { owner: string; name: string }, ref: string, file: string) {
  const k = `${r.owner}/${r.name}@${ref}:${file}`
  if (!blameCache.has(k)) blameCache.set(k, (async () => {
    try {
      // The file as GitHub has it at that commit, so line numbers match the blame (the checkout may differ).
      const content = Buffer.from(JSON.parse(await gh(['api', `repos/${r.owner}/${r.name}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`])).content ?? '', 'base64').toString('utf8')
      const q = `query($o:String!,$n:String!,$e:String!,$p:String!){repository(owner:$o,name:$n){object(expression:$e){... on Commit{blame(path:$p){ranges{startingLine endingLine commit{oid committedDate messageHeadline author{name}}}}}}}}`
      const j = JSON.parse(await gh(['api', 'graphql', '-f', `query=${q}`, '-f', `o=${r.owner}`, '-f', `n=${r.name}`, '-f', `e=${ref}`, '-f', `p=${file}`], 25_000))
      const ranges = (j?.data?.repository?.object?.blame?.ranges ?? []).map((x: any) => {
        const pr = prOf(x.commit.messageHeadline ?? '')
        return { start: x.startingLine, end: x.endingLine, c: { sha: x.commit.oid, date: x.commit.committedDate, author: x.commit.author?.name ?? '', subject: x.commit.messageHeadline ?? '', pr, url: pr ? ghUrl(r, 'pr', pr) : ghUrl(r, 'commit', x.commit.oid) } }
      })
      return { lines: content.split('\n'), ranges }
    } catch { return null }
  })())
  return blameCache.get(k)!
}
async function blameLine(r: { owner: string; name: string }, ref: string, file: string, text: string): Promise<Commit | null> {
  const b = await ghBlame(r, ref, file)
  const needle = text.trim()
  if (!b || !needle) return null
  const i = b.lines.findIndex(l => l.trim() === needle) + 1 || b.lines.findIndex(l => l.includes(needle)) + 1
  return i ? b.ranges.find(x => x.start <= i && i <= x.end)?.c ?? null : null
}
// Commits that rewrite lines without creating them: moves, renames, linters, formatters, import sorting, upgrades.
// Blame stops at them, so the real link is older.
export const MECHANICAL = /\b(move[sd]?|moving|renam\w*|relocat\w*|extract\w*|migrat\w* .* to|ruff|black|prettier|eslint|isort|sort(ed)? imports|lint\w*|format\w*|mypy|pyright|upgrad\w*|bump\w*|codemod|type annotations)\b/i

const earliest = (...cs: (Commit | null)[]) => cs.filter(Boolean).sort((a, b) => a!.date.localeCompare(b!.date))[0] ?? null
const termFor = (c: Concept) => { const n = c.name.replace(/[_-]/g, ' ').replace(/ies$/, 'y').replace(/s$/, ''); return n.length >= 4 && !GENERIC.has(c.name.toLowerCase()) && !GENERIC.has(n.toLowerCase()) ? n : null }

export async function buildTimeline(repo: string, nodes: Concept[], edges: Edge[], progress: (t: Timeline) => void, budgetMs = 150_000): Promise<Timeline> {
  const r = await remoteOf(repo)
  const shallow = (await git(repo, ['rev-parse', '--is-shallow-repository'], 5000).catch(() => 'false')).trim() === 'true'
  const useGh = shallow && !!r && await gh(['auth', 'status'], 8000).then(() => true, () => false)
  // A commit GitHub has that's closest to this checkout (the branch may be unpushed): where to read blame.
  let ghRef: string | null = null
  if (useGh) for (const ref of ['origin/HEAD', 'origin/master', 'origin/main']) { const m = (await git(repo, ['merge-base', 'HEAD', ref], 8000).catch(() => '')).trim(); if (m) { ghRef = m; break } }
  if (useGh && !ghRef) ghRef = 'HEAD'
  // A shallow clone's cut-off commits have no parents, so they mark where the history we have begins.
  const boundary = shallow ? parseLog(await git(repo, ['log', `--format=${FMT}`, '--max-parents=0']).catch(() => ''), r).map(c => c.date).sort()[0] ?? null : null
  const source = useGh ? 'GitHub (this clone is shallow)' : shallow ? `local git (shallow clone: history only since ${boundary?.slice(0, 10)})` : 'local git'
  const t: Timeline = { status: 'running', done: 0, total: nodes.length + edges.length + nodes.length, source, shallow, since: boundary, events: [], milestones: {} }
  const deadline = Date.now() + budgetMs
  const intro = new Map<string, Commit>()
  const step = () => { t.done++; progress(t) }
  for (const c of nodes) {
    if (Date.now() > deadline) { step(); continue }
    try {
      const term = termFor(c)
      const [p, m] = useGh
        ? [await ghFirst(r!, c.path).catch(() => null), term ? await ghMention(r!, term).catch(() => null) : null]
        : [await localFirst(repo, c.path, r).catch(() => null), term && !shallow ? await localMention(repo, term, r).catch(() => null) : null]
      const first = earliest(p, m)
      if (first) {
        intro.set(c.id, first)
        t.events.push({ date: first.date, kind: 'concept', id: c.id, approx: shallow || first === m, source: first === m ? `oldest commit mentioning “${term}”` : `first commit under ${c.path}`, commit: first })
      }
    } catch {}
    step()
  }
  for (const e of edges) {
    if (Date.now() > deadline) { step(); continue }
    let first: Commit | null = null, how = ''
    if (!shallow) {
      for (const ev of e.evidence.slice(0, 2)) {
        const needle = e.kind === 'fk' ? ev.text.split(': ').slice(1).join(': ') : ev.text
        const c = needle ? await localPickaxe(repo, needle, ev.file, r).catch(() => null) : null
        first = earliest(first, c)
      }
      how = 'first commit adding the evidence line'
    } else if (useGh && ghRef) {
      // Shallow clone: GitHub blame on the evidence lines; the earliest one is when this link was written.
      for (const ev of e.evidence.slice(0, 3)) {
        const needle = e.kind === 'fk' ? ev.text.split(': ').slice(1).join(': ') : ev.text
        first = earliest(first, await blameLine(r!, ghRef, ev.file, needle).catch(() => null))
      }
      if (first) {
        const a = intro.get(e.from), b = intro.get(e.to), floor = a && b ? (a.date > b.date ? a : b) : null
        if (MECHANICAL.test(first.subject) && floor && floor.date < first.date) {
          // Blame landed on a rewrite: place the link when both ends existed, and say the range.
          how = `between ${floor.date.slice(0, 7)} (both ends existed) and ${first.date.slice(0, 7)} (the line was rewritten by ${first.pr ? `#${first.pr} ` : ''}“${first.subject.slice(0, 60)}”)`
          first = floor
        } else how = MECHANICAL.test(first.subject) ? `GitHub blame: line last rewritten by “${first.subject.slice(0, 60)}”, so the link is older` : 'GitHub blame: when the line making this link was written'
      }
    }
    const a = intro.get(e.from), b = intro.get(e.to)
    // Without full history: the link can't be older than either end, so place it when the later one appeared.
    if (!first && a && b) { first = a.date > b.date ? a : b; how = 'estimated: when both ends existed' }
    if (first) t.events.push({ date: first.date, kind: 'edge', id: `${e.from}→${e.to}`, from: e.from, to: e.to, approx: how.startsWith('estimated') || how.startsWith('between') || how.includes('rewritten'), source: how, commit: first })
    step()
  }
  for (const c of nodes) {
    if (Date.now() > deadline) { step(); continue }
    try {
      // Milestones: the biggest changes in the history we have (the recent window on a shallow clone).
      const out = await git(repo, ['log', '-n', '300', '--no-merges', `--format=@@${FMT}`, '--shortstat', '--', c.path], 20_000)
      const rows: [Commit, number][] = []
      for (const chunk of out.split('@@').filter(Boolean)) {
        const [head, ...rest] = chunk.split('\n'); const [cm] = parseLog(head, r)
        const s = rest.join(' '); const n = Number(/(\d+) insertion/.exec(s)?.[1] ?? 0) + Number(/(\d+) deletion/.exec(s)?.[1] ?? 0)
        if (cm) rows.push([cm, n])
      }
      t.milestones[c.id] = rows.sort((x, y) => y[1] - x[1]).slice(0, 5).map(([cm]) => cm).sort((x, y) => x.date.localeCompare(y.date))
    } catch {}
    step()
  }
  t.events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === 'concept' ? -1 : 1))
  t.status = 'done'
  if (Date.now() > deadline) t.error = 'Stopped at the time budget; some items have no date.'
  return t
}

// ---------- caching and the HTTP-facing functions ----------

let DIR = ''
export function setDataDir(d: string) { DIR = join(d, 'explorer'); mkdirSync(join(DIR, 'dreams'), { recursive: true }) }
const keyOf = (...p: string[]) => createHash('sha1').update(p.join('\0')).digest('hex').slice(0, 16)
const graphs = new Map<string, Promise<Graph>>()
const timelines = new Map<string, Timeline>()

// The scan reads every source file: run it in a child process so the server stays responsive.
function scanInChild(repo: string, sha: string) {
  return new Promise<Graph>((res, rej) => execFile(process.execPath, [fileURLToPath(import.meta.url), '--scan', repo, sha], { maxBuffer: 1 << 30, timeout: 180_000 }, (e, out) => {
    if (e) return rej(e)
    try { res(JSON.parse(out)) } catch (x) { rej(x) }
  }))
}
export async function graphFor(repoPath: string, home?: string): Promise<Graph> {
  const repo = await checkRepo(repoPath, home)
  const sha = (await git(repo, ['rev-parse', 'HEAD'], 5000)).trim()
  const key = keyOf(repo, sha, JSON.stringify(containersFor(repo)))
  const file = DIR && join(DIR, `${key}.json`)
  if (!graphs.has(key)) {
    graphs.set(key, (async () => {
      if (file && existsSync(file)) try { return JSON.parse(readFileSync(file, 'utf8')) as Graph } catch {}
      const g = DIR ? await scanInChild(repo, sha) : await scan(repo, sha)
      if (file) writeFileSync(file, JSON.stringify(g))
      return g
    })())
    graphs.get(key)!.catch(() => graphs.delete(key))
    while (graphs.size > 4) graphs.delete(graphs.keys().next().value!)
  }
  return graphs.get(key)!
}

export async function exploreGraph(repo: string, focus?: string | null, hubs = false) {
  const g = await graphFor(repo)
  const f = focusGraph(g, focus, 25, hubs)
  return { ...f, concepts: g.concepts.length, remote: await remoteOf(g.repo), names: g.concepts.map(c => c.id).concat(Object.keys(g.models)).sort() }
}

export async function exploreTimeline(repo: string, focus?: string | null, onUpdate?: () => void) {
  const g = await graphFor(repo)
  const f = focusGraph(g, focus)
  const key = keyOf('timeline-v2-blame', g.repo, g.sha, focus ?? '', f.nodes.map(n => n.id).join(',')) // bump when dating changes, so saved timelines are rebuilt
  const file = DIR && join(DIR, `timeline-${key}.json`)
  const have = timelines.get(key)
  if (have) return have
  if (file && existsSync(file)) try { const t = JSON.parse(readFileSync(file, 'utf8')); timelines.set(key, t); return t } catch {}
  const t: Timeline = { status: 'running', done: 0, total: 1, source: '', shallow: false, since: null, events: [], milestones: {} }
  timelines.set(key, t)
  buildTimeline(g.repo, f.nodes, f.edges, p => { Object.assign(t, p, { status: 'running' }); onUpdate?.() })
    .then(done => { Object.assign(t, done); if (file) writeFileSync(file, JSON.stringify(t)); onUpdate?.() })
    .catch(e => { t.status = 'done'; t.error = String(e?.message ?? e); timelines.delete(key); onUpdate?.() })
  return t
}

export async function exploreNode(repo: string, id: string) {
  const g = await graphFor(repo)
  const c = g.concepts.find(x => x.id === id) ?? g.concepts.find(x => x.id === g.models[id]?.concept)
  if (!c) throw new Error(`No concept ${id}`)
  const r = await remoteOf(g.repo)
  const files = (await git(g.repo, ['ls-files', '--', c.path])).split('\n').filter(Boolean)
  // What to read first: the team's own notes, then the entry points and the models.
  const docs = files.filter(f => /(^|\/)(README|AGENTS|CLAUDE|CONTRIBUTING|ARCHITECTURE|PERFORMANCE)[^/]*\.md$|(^|\/)(product\.yaml|manifest\.tsx|package\.json|Cargo\.toml|go\.mod)$/i.test(f) && f.split('/').length <= c.path.split('/').length + 2)
  const sized = await Promise.all(files.filter(f => SRC.test(f) && !SKIP.test(f)).map(async f => [f, (await stat(join(g.repo, f)).catch(() => ({ size: 0 }))).size] as const))
  const largest = sized.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f, size]) => ({ file: f, size }))
  const modelFiles = [...new Set(c.models.map(m => g.models[m].file))]
  const recent = parseLog(await git(g.repo, ['log', '-n', '8', `--format=${FMT}`, '--', c.path]).catch(() => ''), r)
  const link = (file: string, line?: number) => ({ file, line, github: ghUrl(r, 'blob', g.sha, file, line), local: join(g.repo, file) })
  // Shared foundations (used by most of the repo) are listed after the links that are specific to this concept.
  const users = new Map<string, number>()
  for (const e of g.edges) users.set(e.to, (users.get(e.to) ?? 0) + 1)
  const hub = (x: string) => (users.get(x) ?? 0) > Math.max(8, g.concepts.length * 0.15)
  const ev = (e: Edge) => ({ ...e, hub: hub(e.from === c.id ? e.to : e.from), evidence: e.evidence.map(x => ({ ...x, ...link(x.file, x.line) })) })
  return {
    concept: c, sha: g.sha, repo: g.repo, tree: ghUrl(r, 'tree', g.sha, c.path),
    dependsOn: g.edges.filter(e => e.from === c.id).sort((a, b) => b.weight - a.weight).map(ev),
    usedBy: g.edges.filter(e => e.to === c.id).sort((a, b) => b.weight - a.weight).map(ev),
    models: c.models.map(m => ({ name: m, ...link(g.models[m].file, g.models[m].line) })),
    relations: c.relations.map(x => ({ ...x, ...link(x.file, x.line) })),
    docs: docs.map(f => link(f)), largest: largest.map(x => ({ ...x, ...link(x.file) })), modelFiles: modelFiles.map(f => link(f)), recent,
  }
}

export async function exploreDream(repo: string, focus: string | null, ops: DreamOp[]) {
  const g = await graphFor(repo)
  return { ...dream(g, ops), focus: focusGraph(g, focus).nodes.map(n => n.id) }
}

export function saveDream(d: { repo: string; sha?: string; focus?: string | null; name?: string; ops: DreamOp[]; result?: unknown }) {
  if (!DIR) throw new Error('No data folder')
  const id = `${new Date().toISOString().slice(0, 10)}-${keyOf(JSON.stringify(d), String(Date.now())).slice(0, 6)}`
  writeFileSync(join(DIR, 'dreams', `${id}.json`), JSON.stringify({ id, at: Date.now(), ...d }, null, 2))
  return { id, path: join(DIR, 'dreams', `${id}.json`) }
}

// Child-process entry: node explorer.ts --scan <repo> <sha>
if (process.argv[2] === '--scan' && process.argv[1] === fileURLToPath(import.meta.url)) {
  scan(process.argv[3], process.argv[4]).then(g => process.stdout.write(JSON.stringify(g)), e => { console.error(e); process.exit(1) })
}

// Open a file from the map in the editor, at the line the evidence points to. Only files inside the checked repo.
export async function openLocal(repoPath: string, file: string, line?: number) {
  const repo = await checkRepo(repoPath)
  const full = realpathSync(join(repo, file))
  if (!full.startsWith(repo + sep)) throw new Error('Outside the repo')
  const run = (cmd: string, args: string[]) => new Promise<boolean>(res => execFile(cmd, args, { timeout: 8000 }, e => res(!e)))
  for (const ed of ['cursor', 'code']) if (await run(ed, ['-g', `${full}:${line ?? 1}`])) return { ok: true, editor: ed }
  await run('open', ['-R', full])
  return { ok: true, editor: 'finder' }
}
