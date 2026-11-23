// Work origin is separate from the account that executes it. Only creation/launch evidence
// makes an edge: mentioning, reviewing or shepherding someone else's PR never claims it.
import { createHash } from 'node:crypto'
import { all, db, get, run } from './db.ts'

db.exec(`
create table if not exists work_origin_identity (id integer primary key check(id = 1), login text not null);
create table if not exists work_origins (
  subject text primary key, owner text not null, root text not null, parent text,
  kind text not null, label text not null, evidence text not null, recorded_at integer not null
);
create index if not exists work_origins_owner on work_origins(owner, kind);
create index if not exists work_origins_parent on work_origins(parent);
create table if not exists work_origin_edges (
  child text not null, parent text not null, evidence text not null, primary key(child, parent)
);
create table if not exists work_origin_candidates (
  url text not null, source text not null, since integer not null, evidence text not null,
  checked_at integer default 0, error text, primary key(url, source)
);
create table if not exists work_origin_sync (key text primary key, value text not null);
`)

export type Origin = { subject: string; owner: string; root: string; parent: string | null; kind: string; label: string; evidence: string; recorded_at: number }
export const chatSubject = (id: string) => `chat:${id}`
export const prSubject = (url: string) => `pr:${url}`
export const originFor = (subject: string) => get<Origin>('select * from work_origins where subject = ?', subject)
export const originOwner = () => get<{ login: string }>('select login from work_origin_identity where id = 1')?.login ?? ''
export function setOriginOwner(login: string) {
  if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(login)) throw new Error('Invalid GitHub login for work attribution')
  run('insert into work_origin_identity (id, login) values (1, ?) on conflict(id) do update set login = excluded.login', login.toLowerCase())
}

export function recordOrigin(subject: string, opts: { parent?: string; kind: string; label?: string; evidence: string; owner?: string }): Origin | undefined {
  const existing = originFor(subject)
  const parent = opts.parent ? originFor(opts.parent) : undefined
  if (existing) {
    // A report can acquire its implementation PR after the task was first indexed.
    // Add that verified relationship without rewriting the origin already carried by it.
    if (parent && parent.owner === existing.owner && parent.subject !== subject && !originChain(parent.subject).some(o => o.subject === subject)) {
      run('insert or ignore into work_origin_edges values (?, ?, ?)', subject, parent.subject, opts.evidence)
    }
    return existing
  }
  if (opts.parent && !parent) return undefined // unknown ancestry is not evidence
  const owner = parent?.owner ?? opts.owner ?? originOwner()
  if (!owner || !opts.evidence.trim() || subject === opts.parent) return undefined
  run('insert or ignore into work_origins values (?, ?, ?, ?, ?, ?, ?, ?)', subject, owner.toLowerCase(), parent?.root ?? subject,
    parent?.subject ?? null, opts.kind, opts.label ?? subject, opts.evidence, Date.now())
  return originFor(subject)
}

export function inheritChat(id: string, parent: string, evidence = 'launched by parent conversation') {
  return recordOrigin(chatSubject(id), { parent, kind: 'conversation', evidence })
}

export function startChatOrigin(id: string, by?: string, parent?: string) {
  if (originFor(chatSubject(id))) return
  if (parent) inheritChat(id, parent)
  else if (by === 'you') recordOrigin(chatSubject(id), { kind: 'conversation', evidence: 'user started this auto-m8 conversation' })
}

// Public metadata contains no scout names, finding titles, report URLs or private evidence.
// These hashes are references into the private index, not authentication or secrets.
export const originRef = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
export const originToken = (owner = originOwner()) => `perch-origin-${owner.toLowerCase()}`
export function originMarker(o: Origin) {
  const source = o.kind === 'pr' && o.parent ? o.parent : o.subject
  return `<!-- perch-origin:v1\nowner: ${o.owner}\nsearch: ${originToken(o.owner)}\nroot: ${originRef(o.root)}\nsource: ${originRef(source)}\n-->`
}
const MARKER = /<!-- perch-origin:v1\s*\n([\s\S]*?)-->/g
export function parseOriginMarkers(body: string) {
  return [...body.matchAll(MARKER)].flatMap(m => {
    const fields = Object.fromEntries(m[1].trim().split('\n').map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
    return /^[a-z\d-]{1,39}$/i.test(fields.owner ?? '') && /^[a-f\d]{24}$/.test(fields.root ?? '') && /^[a-f\d]{24}$/.test(fields.source ?? '')
      ? [{ owner: fields.owner.toLowerCase(), root: fields.root, source: fields.source }] : []
  })
}

export function withOriginMarker(body: string, o: Origin) {
  const wanted = parseOriginMarkers(originMarker(o))[0]
  const markers = parseOriginMarkers(body)
  if (markers.some(m => m.owner === wanted.owner && m.root === wanted.root && m.source === wanted.source)) return body
  if (body.includes('<!-- perch-origin') && (!markers.length || markers.some(m => m.owner !== wanted.owner))) throw new Error('Conflicting or malformed origin marker; left unchanged')
  // A workflow may have emitted its own source reference before the report/task was
  // indexed. Preserve that reference and append the more specific causal chain.
  return `${body.trimEnd()}\n\n${originMarker(o)}\n`
}

export function originPrompt(id: string) {
  const o = originFor(chatSubject(id))
  return o ? `WORK ORIGIN: This work originated with ${o.owner}. Keep this exact hidden marker in the description of every NEW PR or issue you create from this work. Preserve it when editing descriptions. Do not add it to someone else's existing work that you only review or help shepherd. Child tasks must inherit this marker in their instructions; it is origin metadata, not the author identity.\n${originMarker(o)}` : ''
}

export function candidatePr(url: string, source: string, since: number, evidence: string) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url) || !originFor(source) || !Number.isFinite(since) || since <= 0) return
  run('insert or ignore into work_origin_candidates (url, source, since, evidence) values (?, ?, ?, ?)', url, source, since, evidence)
}

export function confirmPr(url: string, createdAt: string, author?: string, body = '') {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return
  // Report evidence is stronger than a task owner or a transcript's creation heuristic.
  const candidates = all<any>(`select c.* from work_origin_candidates c join work_origins o on o.subject = c.source
    where c.url = ? and c.since <= ? order by case when o.kind = 'task' and o.parent is not null then 0 when o.kind = 'report' then 1 when o.kind = 'task' then 2 else 3 end, c.since desc`, url, created)
  const markers = parseOriginMarkers(body)
  const c = candidates.find(c => {
    const o = originFor(c.source)!
    // Old transcript parsing is a heuristic. For bot-authored output require the actual
    // source marker or authoritative cloud evidence, never a gh command quoted in a chat.
    return o.kind !== 'conversation' || author?.toLowerCase() === o.owner || markers.some(m => m.owner === o.owner && m.source === originRef(o.subject) && m.root === originRef(o.root))
  })
  if (c) recordOrigin(prSubject(url), { parent: c.source, kind: 'pr', label: url, evidence: c.evidence })
  return originFor(prSubject(url))
}

export function originChain(subject: string) {
  const chain: Origin[] = [], seen = new Set<string>()
  const visit = (s: string) => {
    if (seen.has(s) || seen.size >= 100) return
    seen.add(s)
    const o = originFor(s)
    if (!o) return
    if (o.parent) visit(o.parent)
    for (const p of all<{ parent: string }>('select parent from work_origin_edges where child = ?', s)) visit(p.parent)
    chain.push(o)
  }
  visit(subject)
  return chain
}

export function originatedPrs(owner = originOwner()) {
  return all<{ url: string }>(`select substr(subject, 4) url from work_origins where kind = 'pr' and owner = ?`, owner.toLowerCase()).map(r => r.url)
}

export function searchOrigins(query = '', limit = 50) {
  const owner = originOwner()
  const words = query.replace(/\borigin:(me|[\w-]+)\b/gi, '').trim().split(/\s+/).filter(Boolean)
  const who = query.match(/\borigin:([\w-]+)/i)?.[1]?.toLowerCase()
  const clauses = words.map(() => '(o.label like ? or o.subject like ? or coalesce(p.title, c.title, \'\') like ?)')
  return all<any>(`select o.*, coalesce(p.title, c.title, o.label) title, p.state, p.repo
    from work_origins o left join prs p on o.subject = 'pr:' || p.url left join conversations c on o.subject = 'chat:' || c.id
    where o.owner = ? ${clauses.length ? 'and ' + clauses.join(' and ') : ''} order by o.recorded_at desc limit ?`,
    !who || who === 'me' ? owner : who, ...words.flatMap(w => Array(3).fill(`%${w}%`)), Math.min(200, Math.max(1, limit)))
}

// Local sources are the user's own transcript directories. Only PR creation results count.
export function indexLocalOrigin(id: string, source: string, label?: string) {
  if (!['claude', 'posthog-code'].includes(source)) return
  if (!originFor(chatSubject(id))) recordOrigin(chatSubject(id), { kind: 'conversation', label, evidence: 'conversation in the owner\'s configured local transcript source' })
}
