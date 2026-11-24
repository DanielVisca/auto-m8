// Files an agent made for you, made easy to take: every file a conversation wrote or created
// (Write/Edit, a zip or report from a command, a path it named in a reply) that exists on disk,
// with view, reveal in Finder, open, copy contents and copy-the-file-itself (paste into Slack).
// Only paths a conversation actually referenced can be read or acted on.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { all, get } from './db.ts'
import { HOME } from './settings.ts'
import { toItems, itemsOf } from './transcript.ts'
import { ATTACH_DIR } from './attachments.ts'

const exec = promisify(execFile)
export type FileRef = { path: string; name: string; size: number; mtime: number; kind: 'text' | 'image' | 'video' | 'pdf' | 'archive' | 'other'; how: string; uses?: FileUse[] }
// Where in the thread a file came up, so the panel can jump there: the message (uuid, else time) and the exact tool call.
export type FileUse = { how: string; uuid?: string; ts?: number; tool?: string }

const KINDS: [FileRef['kind'], RegExp][] = [
  ['image', /\.(png|jpe?g|gif|webp|svg)$/i],
  ['video', /\.(mp4|m4v|mov|webm)$/i],
  ['pdf', /\.pdf$/i],
  ['archive', /\.(zip|tar|tgz|gz|bz2|xz|7z|dmg)$/i],
  ['text', /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|toml|ts|tsx|js|mjs|cjs|py|go|rs|rb|sh|sql|html|css|xml|log|diff|patch|env\.example|ini|conf)$/i],
]
const kindOf = (p: string): FileRef['kind'] => KINDS.find(([, re]) => re.test(p))?.[0] ?? 'other'
// Never these, whatever a transcript says.
const PRIVATE_RE = /\/\.(ssh|gnupg|aws|azure|kube|config\/gh|netrc|docker|npmrc|pypirc|claude\/)|\/\.claude\.json$|\/\.env(\.[\w-]+)?$|credentials|secrets?\b|token|\/Library\/Keychains\/|id_rsa|id_ed25519|\.pem$|\.key$|\.p12$/i
// Plus any dotfile at the top of your home folder (configs that tend to hold tokens).
const PRIVATE = { test: (p: string) => PRIVATE_RE.test(p) || new RegExp(`^${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.[^/]+$`).test(p) }
const allowed = new Set<string>()
// Machinery, not deliverables: databases, logs, transcripts, dependencies, app data.
const NOISE = /\/(node_modules|\.git|\.venv|__pycache__)\/|\/Library\/(Application Support|Caches|Group Containers|Logs)\/|\.(db|sqlite3?|db-wal|db-shm|jsonl|log|lock|pid)$/i
const DELIVERABLE = /\.(zip|tar|tgz|gz|7z|pdf|png|jpe?g|gif|webp|svg|csv|tsv|xlsx?|docx?|pptx?|md|markdown|txt|json|html|ya?ml|sql|diff|patch|mp4|mov)$/i

// Paths that look like files an agent produced: absolute (or ~/), with an extension.
const PATH_RE = /(?:^|[\s`'"(=:>])((?:~|\/(?:Users|private|tmp|var\/folders|Volumes))\/[^\s`'"()<>|;,]*\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.:;<>|])/g
function pathsIn(text: string) {
  const out: string[] = []
  for (const m of String(text ?? '').matchAll(PATH_RE)) out.push(m[1].startsWith('~') ? m[1].replace(/^~/, HOME) : m[1])
  return out
}

const cache = new Map<string, { m: number; files: FileRef[] }>()
export function conversationFiles(conversationId: string): FileRef[] {
  const c = get<any>('select path, cwd from conversations where id = ?', conversationId)
  if (!c?.path || !existsSync(c.path)) return []
  const m = statSync(c.path).mtimeMs
  const hit = cache.get(conversationId)
  if (hit?.m === m) { hit.files.forEach(f => allowed.add(f.path)); return hit.files }
  const seen = new Map<string, string>() // path → how we know about it
  const uses = new Map<string, FileUse[]>()
  const add = (p: string, how: string, at: Omit<FileUse, 'how'>) => {
    if (!p) return
    if (!seen.has(p)) seen.set(p, how)
    const u = uses.get(p) ?? []
    if (u.length < 30 && !u.some(x => x.how === how && x.uuid === at.uuid && x.ts === at.ts)) u.push({ how, ...at })
    uses.set(p, u)
  }
  for (const it of itemsOf(c.path) as any[]) {
    const at = { uuid: it.uuid, ts: it.ts }
    if (it.kind === 'user') { for (const p of pathsIn(it.text)) if (p.startsWith(ATTACH_DIR + '/')) add(p, 'you attached', at); continue }
    if (it.kind !== 'assistant') continue
    for (const b of it.blocks ?? []) {
      if (b.type === 'tool') {
        const fp = b.input?.file_path ?? b.input?.notebook_path
        if (fp && (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit')) add(isAbsolute(fp) ? fp : resolve(c.cwd ?? HOME, fp), b.name === 'Write' ? 'written' : 'edited', { ...at, tool: b.id })
        if (b.name === 'Read' && fp && seen.has(isAbsolute(fp) ? fp : resolve(c.cwd ?? HOME, fp))) add(isAbsolute(fp) ? fp : resolve(c.cwd ?? HOME, fp), 'read', { ...at, tool: b.id })
        if (b.name === 'Bash') for (const p of pathsIn(b.input?.command)) add(p, 'from a command', { ...at, tool: b.id })
      } else if (b.type === 'text') for (const p of pathsIn(b.text)) add(p, 'mentioned', at)
    }
  }
  const files: FileRef[] = []
  for (const [p, how] of seen) {
    if (PRIVATE.test(p) || !existsSync(p)) continue
    // Files it only ran a command on or named count when they look like something made for you.
    if (how !== 'written' && how !== 'edited' && how !== 'you attached' && (NOISE.test(p) || !DELIVERABLE.test(p))) continue
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    files.push({ path: p, name: basename(p), size: st.size, mtime: st.mtimeMs, kind: kindOf(p), how, uses: uses.get(p) })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out = files.slice(0, 80)
  cache.set(conversationId, { m, files: out })
  out.forEach(f => allowed.add(f.path))
  return out
}

// Paths a reply names, checked on demand (for clickable paths in messages): only real files, and
// only ones some conversation referenced.
export function check(path: string) {
  const p = path.startsWith('~') ? path.replace(/^~/, HOME) : path
  if (PRIVATE.test(p) || !existsSync(p)) return null
  if (!allowed.has(p) && !resolve(p).startsWith(ATTACH_DIR + '/') && !referencedRecently(p)) return null
  const st = statSync(p)
  return st.isFile() ? { path: p, name: basename(p), size: st.size, mtime: st.mtimeMs, kind: kindOf(p) } : null
}
// A path shown in a chat before its Files panel was loaded (e.g. a video played inline): allowed
// if one of the most recently active conversations names it.
function referencedRecently(p: string) {
  const short = p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p
  for (const c of all<{ path: string }>('select path from conversations where path is not null order by updated_at desc limit 30')) {
    try { const t = readFileSync(c.path, 'utf8'); if (t.includes(p) || t.includes(short)) { allowed.add(p); return true } } catch {}
  }
  return false
}
const ok = (p: string) => { const f = check(p); if (!f) throw new Error('auto-m8 only opens files a conversation made or mentioned.'); return f }

export async function fileAction(path: string, action: 'reveal' | 'open' | 'copy-file') {
  const f = ok(path)
  if (action === 'reveal') await exec('open', ['-R', f.path])
  else if (action === 'open') await exec('open', [f.path])
  // The file itself on the clipboard: paste into Slack, Mail or Finder as an attachment.
  else await exec('osascript', ['-e', `set the clipboard to (POSIX file ${JSON.stringify(f.path)})`])
  return { ok: true }
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.pdf': 'application/pdf', '.json': 'application/json', '.html': 'text/plain; charset=utf-8', '.zip': 'application/zip' }
export function fileRaw(path: string) {
  const f = ok(path)
  const type = TYPES[extname(f.path).toLowerCase()] ?? (f.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  return { file: f, type }
}
