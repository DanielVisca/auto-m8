// Writing: markdown documents you edit inside auto-m8, with what a doc editor gives you around them.
// The file on disk stays the text (open any .md); this keeps what lives beside it: comments (from you
// or from an agent, always labelled which), research and evidence agents gather, saved versions,
// draft/final, and "no agent text" mode, where agents may comment and research but not write.
// Agents reach all of it through the auto-m8 MCP `doc` tool; docguard.ts stops their file tools from
// writing a locked doc behind its back.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { all, db, get, run } from './db.ts'
import { DATA_DIR, HOME } from './settings.ts'

db.exec(`
create table if not exists docs (
  id text primary key, path text not null unique, title text,
  status text not null default 'draft',        -- draft | final
  agent_text text not null default 'allowed',  -- allowed | blocked (agents comment and research only)
  conversation_id text,                         -- the chat working on it beside the editor
  rev integer not null default 0, hash text, created_at integer, updated_at integer, opened_at integer
);
create table if not exists doc_comments (
  id text primary key, doc_id text not null, parent_id text,
  author_kind text not null, author_name text, conversation_id text,
  quote text, start integer, "end" integer, body text not null,
  resolved integer not null default 0, created_at integer
);
create index if not exists doc_comments_doc on doc_comments(doc_id);
create table if not exists doc_versions (
  id text primary key, doc_id text not null, rev integer, text text not null, label text,
  author_kind text not null, author_name text, created_at integer
);
create index if not exists doc_versions_doc on doc_versions(doc_id, created_at);
create table if not exists doc_research (
  id text primary key, doc_id text not null, title text not null, url text, quote text, note text,
  author_kind text not null, author_name text, conversation_id text, created_at integer
);
create table if not exists doc_ops (doc_id text not null, rev integer not null, old text not null, new text not null, author_name text, at integer);
`)

export const onDocs = new Set<(id?: string) => void>()
const changed = (id?: string) => { writeGuard(); onDocs.forEach(f => f(id)) }

export type Author = { kind: 'person' | 'agent'; name?: string; conversation_id?: string }
export const DOCS_DIR = join(HOME, 'Documents', 'auto-m8')
const TEXT = /\.(md|markdown|mdx|txt)$/i
const PRIVATE = /\/\.(ssh|gnupg|aws|kube|config\/gh)\/|\/\.env|credentials|secret|token|\.pem$|\.key$/i
const hash = (t: string) => createHash('sha1').update(t).digest('base64url').slice(0, 16)
const now = () => Date.now()

// Paths agents may not write (no agent text mode), read by the docguard hook without the server.
export const GUARD_FILE = join(DATA_DIR, 'docs-locked.json')
function writeGuard() {
  try { writeFileSync(GUARD_FILE, JSON.stringify(all<{ path: string }>(`select path from docs where agent_text = 'blocked'`).map(r => r.path))) } catch {}
}
writeGuard()

function cleanPath(p: string) {
  const abs = resolve(String(p ?? '').replace(/^~(?=\/|$)/, HOME))
  if (!isAbsolute(abs) || !TEXT.test(abs)) throw new Error('Only markdown or text files (.md, .markdown, .txt) open in the editor')
  if (PRIVATE.test(abs)) throw new Error('That file looks private; auto-m8 will not open it')
  return abs
}
const readText = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : ''
const titleFrom = (text: string, path: string) => text.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 120) || basename(path, extname(path))

export function docRow(id: string) { return get<any>('select * from docs where id = ?', id) }
function need(id: string) { const d = docRow(id); if (!d) throw new Error(`No doc ${id}`); return d }

// The file changed outside the editor (another app, git, an agent's own tools): count it as a new revision.
function sync(d: any) {
  const text = readText(d.path), h = hash(text)
  if (h !== d.hash) {
    run('update docs set rev = rev + 1, hash = ?, title = ?, updated_at = ? where id = ?', h, titleFrom(text, d.path), now(), d.id)
    d = docRow(d.id)
  }
  return { d, text }
}

export function openDoc(path: string): any {
  const abs = cleanPath(path)
  let d = get<any>('select * from docs where path = ?', abs)
  if (!d) {
    if (!existsSync(abs)) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, '') }
    const text = readText(abs), id = randomUUID().slice(0, 8)
    run('insert into docs (id, path, title, hash, created_at, updated_at, opened_at) values (?, ?, ?, ?, ?, ?, ?)', id, abs, titleFrom(text, abs), hash(text), now(), now(), now())
    d = docRow(id)
    changed(id)
  } else run('update docs set opened_at = ? where id = ?', now(), d.id)
  return d
}

export function newDoc(title = 'Untitled') {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled'
  let path = join(DOCS_DIR, `${slug}.md`)
  for (let i = 2; existsSync(path); i++) path = join(DOCS_DIR, `${slug}-${i}.md`)
  mkdirSync(DOCS_DIR, { recursive: true })
  writeFileSync(path, `# ${title}\n\n`)
  return openDoc(path)
}

export function listDocs() {
  return all<any>(`select d.*, (select count(*) from doc_comments c where c.doc_id = d.id and c.resolved = 0 and c.parent_id is null) open_comments,
    (select count(*) from doc_research r where r.doc_id = d.id) research from docs d order by coalesce(d.opened_at, d.updated_at) desc limit 50`)
    .map(d => ({ ...d, exists: existsSync(d.path) }))
}

// Find where a comment's quoted text is now: the occurrence nearest to where it was.
export function locate(text: string, quote: string | null, start: number | null): [number, number] | null {
  if (!quote) return null
  if (start != null && text.slice(start, start + quote.length) === quote) return [start, start + quote.length]
  let best = -1, i = text.indexOf(quote)
  while (i >= 0) { if (best < 0 || Math.abs(i - (start ?? 0)) < Math.abs(best - (start ?? 0))) best = i; i = text.indexOf(quote, i + 1) }
  return best < 0 ? null : [best, best + quote.length]
}

export function getDoc(id: string) {
  const { d, text } = sync(need(id))
  const comments = all<any>('select * from doc_comments where doc_id = ? order by created_at', id).map(c => {
    const at = locate(text, c.quote, c.start)
    return { ...c, start: at?.[0] ?? null, end: at?.[1] ?? null, detached: !!c.quote && !at }
  })
  const research = all<any>('select * from doc_research where doc_id = ? order by created_at desc', id)
  const versions = all<any>('select id, rev, label, author_kind, author_name, created_at, length(text) size from doc_versions where doc_id = ? order by created_at desc limit 200', id)
  let mtime = 0
  try { mtime = statSync(d.path).mtimeMs } catch {}
  return { doc: { ...d, exists: existsSync(d.path), mtime }, text, comments, research, versions }
}

export function snapshot(id: string, text: string, rev: number, label: string | null, by: Author) {
  const last = get<any>('select text from doc_versions where doc_id = ? order by created_at desc limit 1', id)
  if (last?.text === text && !label) return null
  const vid = randomUUID().slice(0, 8)
  run('insert into doc_versions (id, doc_id, rev, text, label, author_kind, author_name, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', vid, id, rev, text, label, by.kind, by.name ?? null, now())
  return vid
}
// While you type, a version is kept at most every 10 minutes (and before anything replaces the text).
const AUTO_EVERY = 10 * 60_000

export type SaveResult = { ok: true; rev: number } | { conflict: true; rev: number; text: string; ops: { old: string; new: string; author_name: string | null }[] }
export function saveDoc(id: string, text: string, baseRev: number, by: Author = { kind: 'person' }, anchors: { id: string; start: number; end: number; quote: string }[] = []): SaveResult {
  const { d, text: current } = sync(need(id))
  if (baseRev !== d.rev) {
    // Someone else changed it since you loaded it. Agent edits come back as find/replace steps
    // the editor can replay on top of your unsaved typing; anything else is a plain conflict.
    return { conflict: true, rev: d.rev, text: current, ops: all<any>('select old, new, author_name from doc_ops where doc_id = ? and rev > ? order by rev', id, baseRev) }
  }
  if (text === current) return { ok: true, rev: d.rev }
  const lastAt = get<any>('select max(created_at) at from doc_versions where doc_id = ?', id)?.at ?? 0
  if (now() - lastAt > AUTO_EVERY) snapshot(id, current, d.rev, null, { kind: 'person', name: 'before your edits' })
  writeFileSync(d.path, text)
  run('update docs set rev = rev + 1, hash = ?, title = ?, updated_at = ? where id = ?', hash(text), titleFrom(text, d.path), now(), id)
  for (const a of anchors) run('update doc_comments set start = ?, "end" = ?, quote = ? where id = ? and doc_id = ?', a.start, a.end, a.quote, a.id, id)
  changed(id)
  return { ok: true, rev: d.rev + 1 }
}

// An agent's change to the text: a find/replace on the current file. Refused in no-agent-text mode.
export function agentEdit(id: string, oldText: string, newText: string, by: Author) {
  const d0 = need(id)
  if (d0.agent_text === 'blocked') throw new Error('This doc is in "no agent text" mode: agents may comment and add research, but not write the text. Leave a comment with your suggestion instead.')
  const { d, text } = sync(d0)
  let next: string
  if (!oldText) next = text + (text.endsWith('\n') || !text ? '' : '\n') + newText
  else {
    const n = text.split(oldText).length - 1
    if (n === 0) throw new Error('old_text was not found in the doc; read it again and copy the exact text')
    if (n > 1) throw new Error(`old_text appears ${n} times; include more surrounding text so it is unique`)
    next = text.replace(oldText, () => newText)
  }
  snapshot(id, text, d.rev, null, { kind: 'agent', name: `before ${by.name ?? 'an agent'}'s edit` })
  writeFileSync(d.path, next)
  run('update docs set rev = rev + 1, hash = ?, title = ?, updated_at = ? where id = ?', hash(next), titleFrom(next, d.path), now(), id)
  run('insert into doc_ops (doc_id, rev, old, new, author_name, at) values (?, ?, ?, ?, ?, ?)', id, d.rev + 1, oldText, newText, by.name ?? 'agent', now())
  snapshot(id, next, d.rev + 1, null, by)
  changed(id)
  return { rev: d.rev + 1 }
}

export function updateDoc(id: string, patch: { status?: string; agent_text?: string; title?: string; conversation_id?: string | null }) {
  need(id)
  if (patch.status && !['draft', 'final'].includes(patch.status)) throw new Error('status is draft or final')
  if (patch.agent_text && !['allowed', 'blocked'].includes(patch.agent_text)) throw new Error('agent_text is allowed or blocked')
  for (const k of ['status', 'agent_text', 'title', 'conversation_id'] as const) if (patch[k] !== undefined) run(`update docs set ${k} = ? where id = ?`, patch[k], id)
  changed(id)
  return docRow(id)
}

export function addComment(id: string, c: { body: string; quote?: string; start?: number; parent_id?: string }, by: Author) {
  const { text } = sync(need(id))
  if (!String(c.body ?? '').trim()) throw new Error('A comment needs a body')
  let start: number | null = null, end: number | null = null
  if (c.quote && !c.parent_id) {
    const at = locate(text, c.quote, c.start ?? null)
    if (!at) throw new Error('quote was not found in the doc; copy the exact text you are commenting on')
    ;[start, end] = at
  }
  const cid = randomUUID().slice(0, 8)
  run('insert into doc_comments (id, doc_id, parent_id, author_kind, author_name, conversation_id, quote, start, "end", body, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cid, id, c.parent_id ?? null, by.kind, by.name ?? null, by.conversation_id ?? null, c.parent_id ? null : c.quote ?? null, start, end, String(c.body).trim(), now())
  changed(id)
  return get<any>('select * from doc_comments where id = ?', cid)
}
export function resolveComment(cid: string, resolved = true) { const c = get<any>('select doc_id from doc_comments where id = ?', cid); run('update doc_comments set resolved = ? where id = ?', resolved ? 1 : 0, cid); changed(c?.doc_id) }
export function deleteComment(cid: string) { const c = get<any>('select doc_id from doc_comments where id = ?', cid); run('delete from doc_comments where id = ? or parent_id = ?', cid, cid); changed(c?.doc_id) }

export function addResearch(id: string, r: { title: string; url?: string; quote?: string; note?: string }, by: Author) {
  need(id)
  if (!String(r.title ?? '').trim()) throw new Error('Research needs a title')
  const rid = randomUUID().slice(0, 8)
  run('insert into doc_research (id, doc_id, title, url, quote, note, author_kind, author_name, conversation_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    rid, id, String(r.title).trim(), r.url ?? null, r.quote ?? null, r.note ?? null, by.kind, by.name ?? null, by.conversation_id ?? null, now())
  changed(id)
  return get<any>('select * from doc_research where id = ?', rid)
}
export function deleteResearch(rid: string) { const r = get<any>('select doc_id from doc_research where id = ?', rid); run('delete from doc_research where id = ?', rid); changed(r?.doc_id) }

export function version(vid: string) { return get<any>('select * from doc_versions where id = ?', vid) }
export function restoreVersion(vid: string, by: Author = { kind: 'person' }) {
  const v = version(vid)
  if (!v) throw new Error('No such version')
  const d = docRow(v.doc_id)
  if (by.kind === 'agent' && d.agent_text === 'blocked') throw new Error('No agent text mode: agents cannot restore versions')
  const { text } = sync(d)
  snapshot(d.id, text, d.rev, 'before restoring', by)
  writeFileSync(d.path, v.text)
  run('update docs set rev = rev + 1, hash = ?, title = ?, updated_at = ? where id = ?', hash(v.text), titleFrom(v.text, d.path), now(), d.id)
  changed(d.id)
  return { rev: d.rev + 1 }
}

// Markdown to Slack's own markup, for pasting a doc (or part of it) into a message.
export function toSlack(md: string) {
  return md
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/(?<![*\w])_(.+?)_(?!\w)/g, '_$1_')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    .replace(/^\s*[-*]\s+/gm, '• ')
}

// Pangram (an AI-text classifier with low false positives in independent tests). Opt-in: the text is
// sent to Pangram only when you press Check, with your own key. Returns its verdict plus scored
// passages mapped back onto your text.
export async function pangramCheck(text: string, key: string) {
  const base = 'https://text.external-api.pangram.com'
  const headers = { 'x-api-key': key, 'Content-Type': 'application/json' }
  const start = await fetch(`${base}/task`, { method: 'POST', headers, body: JSON.stringify({ text, model: 'default' }), signal: AbortSignal.timeout(30_000) })
  if (start.status === 402) throw new Error('Your Pangram account has no credits. Add credits in the Pangram API dashboard (text costs $0.05 per 100 words), then check again.')
  if (!start.ok) throw new Error(`Pangram said ${start.status}: ${(await start.text()).slice(0, 200)}`)
  const { task_id } = await start.json() as any
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, i < 5 ? 1000 : 2000))
    const r: any = await (await fetch(`${base}/task/${task_id}`, { headers, signal: AbortSignal.timeout(20_000) })).json()
    if (r.stage === 'STAGE_FAILED') throw new Error(r.headline || 'Pangram could not check this text')
    if (r.stage !== 'STAGE_SUCCESS') continue
    const windows = (r.windows ?? []).map((w: any) => {
      // Offsets point into Pangram's (possibly normalised) copy; find each passage in yours.
      const at = locate(text, String(w.text ?? '').trim(), w.start_index ?? 0)
      return { label: w.label, score: w.ai_assistance_score, confidence: w.confidence, start: at?.[0] ?? null, end: at?.[1] ?? null, text: w.text }
    })
    return { verdict: r.prediction_short, headline: r.headline, prediction: r.prediction, fraction_ai: r.fraction_ai, fraction_ai_assisted: r.fraction_ai_assisted, fraction_human: r.fraction_human, version: r.version, windows, at: now() }
  }
  throw new Error('Pangram took too long; try again')
}

// Your Pangram credit balance in dollars (reading it costs nothing). Null when Pangram can't be reached.
export async function pangramBalance(key: string): Promise<number | null> {
  try {
    const r: any = await (await fetch('https://text.external-api.pangram.com/balance', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(10_000) })).json()
    const n = Number(r?.available_balance_usd)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}
