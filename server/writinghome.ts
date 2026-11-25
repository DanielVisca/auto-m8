// Writing home: everything you write in one place. Your docs (the editor's list), the shelf an agent
// keeps of drafted posts and captured ideas (a folder of markdown, e.g. a private blog workshop), and
// where finished pieces can go. Read-only over the files; opening one goes through the docs editor.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listDocs, DOCS_DIR } from './docs.ts'
import { DATA_DIR } from './settings.ts'
import { writeFileSync } from 'node:fs'

// The shelf folder: PERCH_WRITING_SHELF, else ~/Documents/blog-workshop when it exists.
export const shelfDir = () => process.env.PERCH_WRITING_SHELF || join(homedir(), 'Documents', 'blog-workshop')

export type ShelfPost = { slug: string; title: string; point: string; status: string; words: number; draft: string; worksheet: string | null; updated_at: number; excerpt: string; image: string | null }
export type ShelfIdea = { file: string; path: string; title: string; point: string; captured: string; updated_at: number }

// A card's preview: the opening text (title, notes and images taken out) and its first image. Local
// images are served by key only (see imageFile), so the route can't be pointed at any other file.
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i
const images = new Map<string, string>()
const keyOf = (p: string) => createHash('sha1').update(p).digest('base64url').slice(0, 16)
export const imageFile = (key: string) => images.get(key) ?? null
export function preview(text: string, file: string) {
  let image: string | null = null
  const md = text.match(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/) ?? text.match(/<img[^>]+src=["']([^"']+)["']/i)
  if (md) {
    const src = md[1]
    if (/^https:\/\//i.test(src)) image = src
    else if (!/^[a-z]+:/i.test(src)) {
      const abs = isAbsolute(src) ? src : resolve(dirname(file), decodeURIComponent(src))
      if (IMG_EXT.test(abs) && existsSync(abs)) { const k = keyOf(abs); images.set(k, abs); image = `/api/explore/writing/image/${k}` }
    }
  }
  const excerpt = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+.+$/m, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img[^>]*>/gi, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 700)
  return { excerpt, image }
}
const readText = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

const words = (t: string) => (t.replace(/<!--[\s\S]*?-->/g, '').match(/\S+/g) ?? []).filter(w => /\w/.test(w)).length
const heading = (t: string) => t.match(/^#\s+(.+)$/m)?.[1].trim() ?? ''
const mtime = (p: string) => { try { return statSync(p).mtimeMs } catch { return 0 } }

// The shelf README's table: | Post | One thing | Status | Words | [Read](posts/<slug>/draft.md) | ... |
export function parseShelfTable(readme: string) {
  const rows = new Map<string, { title: string; point: string; status: string }>()
  for (const line of readme.split('\n')) {
    const slug = line.match(/\]\(posts\/([^/)]+)\/draft\.md\)/)?.[1]
    if (!slug || !line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    rows.set(slug, { title: cells[0] ?? '', point: cells[1] ?? '', status: cells[2] ?? '' })
  }
  return rows
}

export function readShelf(dir = shelfDir()) {
  if (!existsSync(dir)) return null
  const readme = existsSync(join(dir, 'README.md')) ? readFileSync(join(dir, 'README.md'), 'utf8') : ''
  const table = parseShelfTable(readme)
  const posts: ShelfPost[] = []
  const postsDir = join(dir, 'posts')
  if (existsSync(postsDir)) for (const slug of readdirSync(postsDir)) {
    const draft = join(postsDir, slug, 'draft.md')
    if (!existsSync(draft)) continue
    const text = readFileSync(draft, 'utf8'), row = table.get(slug), ws = join(postsDir, slug, 'worksheet.md')
    posts.push({ slug, title: row?.title || heading(text) || slug, point: row?.point ?? '', status: row?.status || 'draft', words: words(text), draft, worksheet: existsSync(ws) ? ws : null, updated_at: mtime(draft), ...preview(text, draft) })
  }
  const ideas: ShelfIdea[] = []
  const inbox = join(dir, 'inbox')
  if (existsSync(inbox)) for (const file of readdirSync(inbox)) {
    if (!/\.md$/i.test(file)) continue
    const path = join(inbox, file), text = readFileSync(path, 'utf8')
    ideas.push({ file, path, title: heading(text) || file.replace(/\.md$/i, ''), point: text.match(/^-\s*Point:\s*(.+)$/m)?.[1].trim().slice(0, 240) ?? '', captured: file.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '', updated_at: mtime(path) })
  }
  const runs = existsSync(join(dir, 'runs')) ? readdirSync(join(dir, 'runs')).filter(f => f.endsWith('.md')).sort() : []
  const last = runs.at(-1)
  return {
    dir, readme: existsSync(join(dir, 'README.md')) ? join(dir, 'README.md') : null,
    posts: posts.sort((a, b) => b.updated_at - a.updated_at),
    ideas: ideas.sort((a, b) => b.captured.localeCompare(a.captured) || b.updated_at - a.updated_at),
    last_run: last ? { file: last, path: join(dir, 'runs', last), at: mtime(join(dir, 'runs', last)) } : null,
  }
}

// Where finished writing can go. None publish yet: each says how it will connect.
export const DESTINATIONS = [
  { id: 'slack', name: 'Slack (copy)', status: 'ready', how: 'In a doc, Copy for Slack turns the markdown into Slack formatting to paste into a thread or channel.' },
  { id: 'gdrive', name: 'Google Drive', status: 'planned', how: 'Connect Google Drive (claude.ai connector or OAuth). Publish makes a Google Doc from the draft in a folder you pick, and later publishes update it.' },
  { id: 'posthog', name: 'posthog.com', status: 'planned', how: 'Opens a pull request to PostHog/posthog.com with the post as an .mdx file under contents/blog, ready for review. Uses your gh login.' },
  { id: 'hook', name: 'Custom hook', status: 'planned', how: 'Give a URL and an optional secret. Publish POSTs JSON { title, markdown, html, path, status } signed with the secret, so any CMS, Zapier, n8n or your own script can take it from there.' },
] as const

// Pinned: the pieces you're working on now, newest pin first. Paths, so any markdown file can be
// pinned (a doc, a shelf draft, a file you opened from the finder). Missing files drop out.
const PIN_FILE = () => join(DATA_DIR, 'writing-pins.json')
export function pins(): string[] { try { const v = JSON.parse(readFileSync(PIN_FILE(), 'utf8')); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] } catch { return [] } }
export function setPin(path: string, on: boolean) {
  path = String(path ?? '').replace(/^~(?=\/|$)/, HOME)
  if (!isAbsolute(path) || !TEXT.test(path)) throw new Error('Only markdown or text files can be pinned')
  const next = [...(on ? [path] : []), ...pins().filter(p => p !== path)].slice(0, 24)
  writeFileSync(PIN_FILE(), JSON.stringify(next))
  return { pins: next }
}
function pinned(shelf: ReturnType<typeof readShelf>, docs: any[]) {
  return pins().filter(p => existsSync(p)).map(path => {
    const text = readText(path), post = shelf?.posts.find(x => x.draft === path), doc = docs.find(d => d.path === path)
    return { path, title: post?.title || doc?.title || heading(text) || basename(path).replace(/\.\w+$/, ''), status: post?.status ?? doc?.status ?? null,
      words: words(text), open_comments: doc?.open_comments ?? 0, worksheet: post?.worksheet ?? null, updated_at: mtime(path), ...preview(text, path) }
  })
}

export function writingHome() {
  const docs = listDocs().map((d: any) => ({ ...d, ...(d.exists ? preview(readText(d.path), d.path) : { excerpt: '', image: null }) }))
  const shelf = readShelf()
  return {
    docs, dir: DOCS_DIR, shelf, pinned: pinned(shelf, docs),
    reviews: docs.filter((d: any) => d.open_comments > 0).length,
    destinations: DESTINATIONS,
  }
}

// The open box's finder. A path (~/… or /…) lists that folder: subfolders and markdown files whose
// names start with what you typed after the last /. Anything else searches markdown files in your
// home folder by name with Spotlight; empty shows the ones changed in the last two weeks.
const HOME = homedir()
const TEXT = /\.(md|markdown|mdx|txt)$/i
const SKIP = /\/(node_modules|\.git|Library|\.Trash|\.cache|dist|build|\.venv|venv|vendor|\.perch-worktrees)\/|\/\.[^/]+\//
const PRIVATE = /\/\.(ssh|gnupg|aws|kube|docker|config\/gh)(\/|$)|credentials|secrets?\b/i
const run = promisify(execFile)
export type Found = { path: string; name: string; dir: boolean; updated_at: number }
export async function findWriting(q: string): Promise<{ mode: 'folder' | 'search' | 'recent'; folder?: string; items: Found[] }> {
  q = q.trim()
  if (/^[~/]/.test(q)) {
    const abs = q.replace(/^~(?=\/|$)/, HOME)
    const folder = abs.endsWith('/') ? abs : dirname(abs), prefix = abs.endsWith('/') ? '' : basename(abs).toLowerCase()
    if (PRIVATE.test(folder + '/')) return { mode: 'folder', folder, items: [] }
    let names: string[] = []
    try { names = readdirSync(folder) } catch {}
    const items = names.filter(n => !n.startsWith('.') && n.toLowerCase().startsWith(prefix)).flatMap(n => {
      const p = join(folder, n)
      try { const st = statSync(p); return st.isDirectory() ? [{ path: p, name: n, dir: true, updated_at: st.mtimeMs }] : TEXT.test(n) ? [{ path: p, name: n, dir: false, updated_at: st.mtimeMs }] : [] } catch { return [] }
    }).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).slice(0, 60)
    return { mode: 'folder', folder, items }
  }
  const safe = q.replace(/["\\*]/g, '')
  const query = safe ? `kMDItemFSName == "*${safe}*"cd && (kMDItemFSName == "*.md"c || kMDItemFSName == "*.markdown"c || kMDItemFSName == "*.mdx"c)`
    : `kMDItemFSContentChangeDate >= $time.today(-14) && (kMDItemFSName == "*.md"c || kMDItemFSName == "*.markdown"c)`
  // Recent looks where people keep writing, not code repos (their READMEs and SKILL.md files churn daily).
  const icloud = join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  const where = safe ? [HOME] : [join(HOME, 'Documents'), join(HOME, 'Desktop'), join(HOME, 'Downloads'), icloud, shelfDir()].filter(d => existsSync(d))
  let out = ''
  try { out = (await run('mdfind', [...where.flatMap(d => ['-onlyin', d]), query], { timeout: 4000, maxBuffer: 8 << 20 })).stdout } catch (e: any) { out = e?.stdout ?? '' }
  const items = [...new Set(out.split('\n'))].filter(p => p && TEXT.test(p) && !SKIP.test(p.startsWith(icloud) ? p.slice(icloud.length) : p) && !PRIVATE.test(p))
    .map(p => ({ path: p, name: basename(p), dir: false, updated_at: mtime(p) })).sort((a, b) => b.updated_at - a.updated_at).slice(0, 40)
  return { mode: safe ? 'search' : 'recent', items }
}
export const imageType = (p: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' } as Record<string, string>)[extname(p).toLowerCase()] ?? 'application/octet-stream'
