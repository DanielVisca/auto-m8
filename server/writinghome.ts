// Writing home: everything you write in one place. Your docs (the editor's list), the shelf an agent
// keeps of drafted posts and captured ideas (a folder of markdown, e.g. a private blog workshop), and
// where finished pieces can go. Read-only over the files; opening one goes through the docs editor.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { listDocs, DOCS_DIR } from './docs.ts'

// The shelf folder: PERCH_WRITING_SHELF, else ~/Documents/blog-workshop when it exists.
export const shelfDir = () => process.env.PERCH_WRITING_SHELF || join(homedir(), 'Documents', 'blog-workshop')

export type ShelfPost = { slug: string; title: string; point: string; status: string; words: number; draft: string; worksheet: string | null; updated_at: number }
export type ShelfIdea = { file: string; path: string; title: string; point: string; captured: string; updated_at: number }

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
    posts.push({ slug, title: row?.title || heading(text) || slug, point: row?.point ?? '', status: row?.status || 'draft', words: words(text), draft, worksheet: existsSync(ws) ? ws : null, updated_at: mtime(draft) })
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

export function writingHome() {
  const docs = listDocs()
  return {
    docs, dir: DOCS_DIR, shelf: readShelf(),
    reviews: docs.filter((d: any) => d.open_comments > 0).length,
    destinations: DESTINATIONS,
  }
}
