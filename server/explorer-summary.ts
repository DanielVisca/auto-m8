// "What is this?" for a concept on the architecture map. First the team's own words (product.yaml, README,
// AGENTS.md/CLAUDE.md, a package docstring), which are instant and exact. Then, when those are thin, a short
// AI summary written only from the module's docs, models and largest files, citing them. AI summaries are
// cached by the folder's git tree hash, so they're redone only when that module's code changes.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ephemeral } from './chat.ts'
import { DATA_DIR, settings } from './settings.ts'
import { checkRepo, drillEdges, findConcept, graphFor } from './explorer.ts'

const DIR = join(DATA_DIR, 'explorer', 'summaries')
mkdirSync(DIR, { recursive: true })
const git = (repo: string, args: string[]) => new Promise<string>((res, rej) => execFile('git', ['-C', repo, ...args], { maxBuffer: 32 << 20, timeout: 15_000 }, (e, out) => e ? rej(e) : res(out)))
const read = (p: string, n = 6000) => { try { return readFileSync(p, 'utf8').slice(0, n) } catch { return '' } }

export type Own = { text: string; file: string }
// The first real paragraph of a markdown file: skip headings, badges and front matter.
export function firstParagraph(md: string): string {
  const body = md.replace(/^---[\s\S]*?---\s*/, '')
  for (const para of body.split(/\n\s*\n/)) {
    const t = para.trim()
    if (!t || /^#|^!\[|^<|^\||^```|^\[!/.test(t) || /^[-*]\s/.test(t)) continue
    return t.replace(/\s+/g, ' ').slice(0, 400)
  }
  return ''
}
// A Python package docstring, or a leading block comment in a TS/JS file.
export function leadingDoc(src: string): string {
  const py = /^\s*(?:#[^\n]*\n\s*)*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(src)?.[1]
  const js = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(src)?.[1]?.replace(/^\s*\* ?/gm, '')
  const t = (py ?? js ?? '').trim().replace(/\s+/g, ' ')
  return t.length >= 30 ? t.slice(0, 400) : ''
}

async function own(repo: string, path: string): Promise<Own | null> {
  const files = (await git(repo, ['ls-files', '--', path]).catch(() => '')).split('\n').filter(Boolean)
  const depth = path.split('/').length
  const near = (re: RegExp) => files.filter(f => re.test(f) && f.split('/').length <= depth + 1)
  for (const f of near(/(^|\/)product\.ya?ml$/)) { const d = /^\s*description:\s*["']?(.+?)["']?\s*$/m.exec(read(join(repo, f)))?.[1]; if (d && d.length > 20) return { text: d, file: f } }
  // AGENTS.md / CLAUDE.md are instructions for agents, not descriptions; the AI summary reads them instead.
  for (const f of near(/(^|\/)README\.md$/i)) { const p = firstParagraph(read(join(repo, f))); if (p.length > 30) return { text: p, file: f } }
  for (const f of near(/(^|\/)(__init__\.py|index\.tsx?|mod\.rs|lib\.rs|doc\.go)$/)) { const d = leadingDoc(read(join(repo, f))); if (d) return { text: d, file: f } }
  return null
}

export type Summary = { own: Own | null; ai: { text: string; sources: string[]; model: string; at: number } | null; status: 'ready' | 'generating' | 'error'; error?: string }
const pending = new Map<string, Promise<void>>()
let running = 0
const queue: (() => void)[] = []
const slot = () => new Promise<void>(res => { if (running < 2) { running++; res() } else queue.push(() => { running++; res() }) })
const free = () => { running--; queue.shift()?.() }

// Short, scannable markdown: one line of purpose, then labelled bullets. Read at a glance in a narrow panel.
const PROMPT = `You explain one module of a codebase to a senior engineer who is new to it. Using ONLY the material below, write markdown in exactly this shape:
<one plain sentence, under 20 words: what it is for, as a reader would say it>
- **Main data:** <its key models or tables, as \`Code\` names, at most 5>
- **Connects to:** <the 2-4 things it's built on or that use it that matter most, in plain words>
- **Watch out:** <only if the material states a real gotcha or rule; otherwise omit this line>
Each bullet under 20 words: the single most important point, not a list of rules. No fluff, no "This module". If the material doesn't say, write "unclear" rather than guess. Then a line "SOURCES:" listing the file paths you relied on, comma separated.`

async function generate(repo: string, id: string, key: string) {
  await slot()
  try {
    const g = await graphFor(repo)
    const c = findConcept(g, id)
    if (!c) throw new Error(`No concept ${id}`)
    const files = (await git(repo, ['ls-files', '--', c.path])).split('\n').filter(Boolean)
    const docs = files.filter(f => /(^|\/)(README|AGENTS|CLAUDE|ARCHITECTURE)[^/]*\.md$|product\.ya?ml$/i.test(f) && f.split('/').length <= c.path.split('/').length + 2).slice(0, 3)
    const src = files.filter(f => /\.(py|ts|tsx|go|rs)$/.test(f) && !/(^|\/)(tests?|__tests__|migrations)\/|\.test\.|test_/.test(f))
    // The biggest source files say most about what a module does; their first lines carry imports and names.
    const sized = src.map(f => { try { return [f, readFileSync(join(repo, f)).length] as const } catch { return [f, 0] as const } }).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f)
    const out = (l: { to?: string; from?: string; weight: number }[], k: 'to' | 'from') => l.sort((a, b) => b.weight - a.weight).slice(0, 6).map(e => e[k]).join(', ')
    const material = [
      `Module: ${c.path} (${c.files} files)`,
      c.models.length ? `Models: ${c.models.slice(0, 20).join(', ')}` : '',
      c.relations.length ? `Foreign keys: ${c.relations.slice(0, 12).map(r => `${r.model}→${r.target}`).join(', ')}` : '',
      `Built on: ${out((drillEdges(g, c.id) ?? g.edges).filter(e => e.from === c.id), 'to')}`,
      `Used by: ${out((drillEdges(g, c.id) ?? g.edges).filter(e => e.to === c.id), 'from')}`,
      `Top-level entries: ${[...new Set(files.map(f => f.slice(c.path.length + 1).split('/')[0]))].slice(0, 30).join(', ')}`,
      ...docs.map(f => `--- ${f}\n${read(join(repo, f), 2500)}`),
      ...sized.map(f => `--- ${f} (first lines)\n${read(join(repo, f), 1800)}`),
    ].filter(Boolean).join('\n')
    const text = await new Promise<string>((res, rej) => {
      let out = ''
      ephemeral(['-p', `${PROMPT}\n\n${material}`, '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
        if (ev.type === 'result') out = String(ev.result ?? '')
        if (ev.type === 'perch_done') out.trim() ? res(out.trim()) : rej(new Error('no answer from the model'))
      })
    })
    const [body, srcLine] = text.split(/\n?SOURCES:/i)
    const sources = (srcLine ?? '').split(',').map(s => s.trim()).filter(s => s && files.includes(s))
    writeFileSync(join(DIR, `${key}.json`), JSON.stringify({ text: body.trim().slice(0, 900), sources, model: 'haiku', at: Date.now() }))
  } catch (e: any) {
    writeFileSync(join(DIR, `${key}.err`), String(e?.message ?? e))
  } finally { free() }
}

// The folder's tree hash: changes exactly when something in that module changes.
const VERSION = 'v3' // bump when the prompt or shape changes, so old summaries are rewritten
async function keyOf(repo: string, path: string) {
  const tree = (await git(repo, ['rev-parse', `HEAD:${path}`]).catch(() => '')).trim()
  return tree ? `${VERSION}-${tree.slice(0, 20)}` : null
}

export async function summaryFor(repoPath: string, id: string, generateIfThin = true): Promise<Summary> {
  const repo = await checkRepo(repoPath)
  const g = await graphFor(repo)
  const c = findConcept(g, id)
  if (!c) throw new Error(`No concept ${id}`)
  const o = await own(repo, c.path)
  const key = await keyOf(repo, c.path)
  if (!key) return { own: o, ai: null, status: 'ready' }
  const f = join(DIR, `${key}.json`)
  if (existsSync(f)) return { own: o, ai: JSON.parse(readFileSync(f, 'utf8')), status: 'ready' }
  if (existsSync(join(DIR, `${key}.err`))) return { own: o, ai: null, status: 'error', error: read(join(DIR, `${key}.err`), 300) }
  // The team's words are enough when they're a real paragraph; otherwise write one.
  if (!generateIfThin) return { own: o, ai: null, status: 'ready' }
  if (!pending.has(key)) pending.set(key, generate(repo, id, key).finally(() => pending.delete(key)))
  return { own: o, ai: null, status: 'generating' }
}

// Warm the summaries for what's on screen, a few at a time in the background.
export async function warmSummaries(repoPath: string, ids: string[]) {
  for (const id of ids.slice(0, 12)) summaryFor(repoPath, id).catch(() => {})
  return { ok: true, warming: Math.min(12, ids.length) }
}
