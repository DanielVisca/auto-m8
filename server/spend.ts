// AI spend: what everything you run would cost at API prices, per account (profile), and where it
// comes from. Reads every Claude Code transcript on this Mac (perch chats and its automations,
// terminal sessions, Claude Desktop, PostHog Code) and prices each API response from its own token
// counts, plus what your PostHog scouts cost in the cloud (their runs report total_spend).
//
// Transcripts are read incrementally (byte offset per file) into usage_msgs, one row per API
// response, so history stays even after Claude Code prunes old transcripts.
import { defaultClaudeId, subLabelOf } from './subscriptions.ts'
import { open, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { all, db, get, run } from './db.ts'
import { PROFILE_ID, profiles } from './profile.ts'
import { settings } from './settings.ts'
import { posthogKey } from './keychain.ts'
import { HOME } from './settings.ts'

db.exec(`create table if not exists usage_msgs (
  id text primary key, ts integer not null, account text not null, source text not null, session text, cwd text, model text,
  in_tok integer, out_tok integer, cache_read integer, cache_write integer, cost real, sidechain integer default 0)`)
db.exec('create index if not exists usage_msgs_ts on usage_msgs (ts)')
db.exec('create index if not exists usage_msgs_session on usage_msgs (session)') // the list's per-chat model icons
db.exec('create table if not exists usage_files (path text primary key, size integer, offset integer)')

// ---------- prices, USD per million tokens ----------
// [input, output, cache read]. Cache writes are 1.25× input (5-minute TTL) or 2× (1-hour).
// Fast mode is 2× everything. Unknown non-Claude models (local ones) cost nothing.
const PRICES: [RegExp, number, number, number][] = [
  [/^claude-(fable|mythos)-5-2/, 8, 40, 0.2],
  [/^claude-(fable|mythos)-5-1/, 10, 50, 0.25],
  [/^claude-(fable|mythos)-5/, 10, 50, 1],
  [/^claude-opus-5-5/, 4, 20, 0.2],
  [/^claude-opus-5/, 5, 25, 0.5],
  [/^claude-opus-4-[5-9]/, 5, 25, 0.5],
  [/^claude-opus-4/, 15, 75, 1.5],
  [/^claude-sonnet-5-5/, 2, 10, 0.1],
  [/^claude-sonnet-5/, 2, 10, 0.2],
  [/^claude-sonnet-4|^claude-3-[57]-sonnet/, 3, 15, 0.3],
  [/^claude-haiku-5-5/, 0.1, 0.5, 0.01],
  [/^claude-haiku-4/, 1, 5, 0.1],
  [/^claude-3-5-haiku/, 0.8, 4, 0.08],
]
export function priceOf(model: string, u: any): number {
  const m = model.replace(/^(us\.|eu\.)?anthropic\./, '').replace(/\[1m\]$/, '')
  const p = PRICES.find(([re]) => re.test(m))
  if (!p) return 0
  let [, inP, outP, readP] = p
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, read = u.cache_read_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0)
  // Haiku 5.5 charges 5× for prompts over 100K tokens.
  if (/haiku-5-5/.test(m) && input + read + w1h + w5m > 100_000) { inP *= 5; outP *= 5; readP *= 5 }
  const fast = u.speed === 'fast' ? 2 : 1
  const tokens = (input * inP + output * outP + read * readP + w5m * inP * 1.25 + w1h * inP * 2) / 1e6
  const web = (u.server_tool_use?.web_search_requests ?? 0) * 0.01
  return tokens * fast + web
}

// ---------- where transcripts live, per account ----------
const POSTHOG_CODE = join(HOME, 'Library/Application Support/@posthog/posthog-code/claude/projects')
function roots() {
  const out: { account: string; dir: string; kind: 'claude' | 'posthog-code' }[] = []
  for (const p of profiles()) {
    if (!p.enabled && p.id !== 'work') continue
    out.push({ account: p.id, dir: join(p.claudeDir, 'projects'), kind: 'claude' })
    if (p.id === 'work') out.push({ account: p.id, dir: POSTHOG_CODE, kind: 'posthog-code' })
  }
  return out.filter(r => existsSync(r.dir))
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let ents
  try { ents = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* jsonlFiles(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}

const sourceOf = (kind: string, entrypoint?: string) =>
  kind === 'posthog-code' ? 'posthog-code'
    : entrypoint === 'cli' ? 'terminal'
    : entrypoint === 'claude-desktop' ? 'desktop'
    : entrypoint === 'sdk-cli' ? 'perch'
    : entrypoint ? entrypoint : 'other'

const insert = () => db.prepare(`insert or ignore into usage_msgs (id, ts, account, source, session, cwd, model, in_tok, out_tok, cache_read, cache_write, cost, sidechain)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const tick = () => new Promise(r => setImmediate(r))

// Reads what's new in one file since last time (only whole lines).
async function ingestFile(path: string, account: string, kind: string, ins: ReturnType<typeof insert>) {
  let st
  try { st = await stat(path) } catch { return 0 }
  const seen = get<{ size: number; offset: number }>('select size, offset from usage_files where path = ?', path)
  let offset = seen && st.size >= seen.offset ? seen.offset : 0
  if (offset >= st.size) return 0
  const fh = await open(path, 'r')
  let added = 0
  try {
    const CHUNK = 4 << 20
    let carry = ''
    while (offset < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - offset))
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
      if (!bytesRead) break
      const text = carry + buf.subarray(0, bytesRead).toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      const whole = lastNl < 0 ? '' : text.slice(0, lastNl)
      carry = lastNl < 0 ? text : text.slice(lastNl + 1)
      offset += bytesRead
      db.exec('begin')
      try {
        for (const line of whole.split('\n')) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
          let e: any; try { e = JSON.parse(line) } catch { continue }
          const msg = e.message, u = msg?.usage
          if (e.type !== 'assistant' || !u || !msg.model || msg.model === '<synthetic>') continue
          const id = `${msg.id ?? e.uuid}:${e.requestId ?? ''}`
          const ts = Date.parse(e.timestamp) || st.mtimeMs
          const write = u.cache_creation_input_tokens ?? 0
          const r = ins.run(id, ts, account, sourceOf(kind, e.entrypoint), e.sessionId ?? null, e.cwd ?? null, msg.model,
            u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, write, priceOf(msg.model, u), e.isSidechain || path.includes('/subagents/') ? 1 : 0)
          added += Number(r.changes)
        }
        db.exec('commit')
      } catch (err) { db.exec('rollback'); throw err }
      await tick()
    }
    // A trailing partial line is read again next time.
    run('insert or replace into usage_files (path, size, offset) values (?, ?, ?)', path, st.size, offset - Buffer.byteLength(carry))
  } finally { await fh.close() }
  return added
}

export const spendScan = { running: false, at: 0, files: 0, added: 0, error: null as string | null }
export async function scanTranscripts() {
  if (spendScan.running) return
  spendScan.running = true; spendScan.files = 0; spendScan.added = 0
  try {
    const ins = insert()
    for (const r of roots()) for await (const f of jsonlFiles(r.dir)) {
      spendScan.files++
      spendScan.added += await ingestFile(f, r.account, r.kind, ins).catch(() => 0)
    }
    spendScan.at = Date.now(); spendScan.error = null
  } catch (e: any) { spendScan.error = String(e?.message ?? e) } finally { spendScan.running = false }
}

export function startSpend() {
  setTimeout(() => scanTranscripts(), 20_000)
  setInterval(() => scanTranscripts(), 10 * 60_000).unref?.()
}

// ---------- scouts: cloud spend from PostHog ----------
// The work profile's server holds the PostHog key. Other servers ask it over localhost.
type ScoutSpend = { usd: number; runs: number; untracked: number; scouts: { name: string; skill: string; usd: number; runs: number }[] } | null
async function scoutSpend(days: number): Promise<{ account: string; data: ScoutSpend; error?: string }> {
  try {
    if (!posthogKey()) throw new Error('no PostHog key in this profile')
    const { scouts } = await import('./posthog.ts')
    const mine = (await scouts.list({ mine: true })).results.filter((s: any) => s.skill_name)
    const spent = await scouts.spend(mine.map((s: any) => s.skill_name), days)
    const list = mine.map((s: any) => ({ name: s.display_name || s.skill_name, skill: s.skill_name, ...(spent.by_skill[s.skill_name] ?? { usd: 0, runs: 0, untracked: 0 }) }))
      .filter((s: any) => s.runs > 0).sort((a: any, b: any) => b.usd - a.usd)
    return { account: PROFILE_ID, data: { usd: spent.total_usd, runs: list.reduce((a: number, s: any) => a + s.runs, 0), untracked: list.reduce((a: number, s: any) => a + Math.max(0, s.untracked), 0), scouts: list } }
  } catch (e: any) { return { account: PROFILE_ID, data: null, error: String(e?.message ?? e) } }
}
export const localScoutSpend = scoutSpend

async function allScoutSpend(days: number) {
  const out = [await scoutSpend(days)]
  for (const p of profiles().filter(p => p.enabled && p.id !== PROFILE_ID)) {
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/api/spend/scouts?days=${days}`, { signal: AbortSignal.timeout(20_000) })
      if (r.ok) out.push(await r.json() as any)
    } catch {}
  }
  return out
}

// ---------- the summary ----------
const SOURCE_LABEL: Record<string, string> = { perch: 'Perch', terminal: 'Terminal (Claude Code)', desktop: 'Claude Desktop', 'posthog-code': 'PostHog Code', scouts: 'PostHog scouts (cloud)' }

// How a message was billed: the chat's process (chat_account_span, from when it started) for perch
// chats (your Claude Code login, your API key, or a local model); otherwise the Claude Code login.
const SUB = `coalesce((select s.account from chat_account_span s where s.id = m.session and s.from_ts <= m.ts order by s.from_ts desc limit 1), 'login')`
const subLabel = (id: string) => id === 'login' ? `Claude · ${subLabelOf(defaultClaudeId())?.slice(9) ?? 'Claude Code login'}` : id === 'api' ? 'API key' : id === 'local' ? 'Local models' : subLabelOf(id) ?? 'Other'

export async function spendSummary(days = 30, subscription?: string) {
  const since = Date.now() - days * 86400_000
  const subFilter = subscription ? `and ${SUB} = ?` : ''
  const subArgs = subscription ? [subscription] : []
  // Perch chats split by who started them: you, or an automation (shepherd, routine, ...).
  const rows = all<any>(`select m.account, m.source, coalesce(ps.by, case when m.source = 'perch' then 'you' end) by_, m.session, m.cwd, m.model,
      count(*) n, sum(m.cost) cost, sum(m.in_tok + m.out_tok + m.cache_read + m.cache_write) tokens, sum(m.out_tok) out_tok, sum(m.sidechain) sub,
      min(m.ts) first, max(m.ts) last
    from usage_msgs m left join perch_started ps on ps.id = m.session
    where m.ts > ? ${subFilter} group by 1, 2, 3, 4, 5, 6`, since, ...subArgs)
  const days_ = all<any>(`select m.account, m.source, cast((m.ts - ?) / 86400000 as integer) d, sum(m.cost) cost from usage_msgs m where m.ts > ? ${subFilter} group by 1, 2, 3`, since, since, ...subArgs)
  // Breakdown by subscription, always across all of them (the filter only narrows the cards below).
  const subs = all<any>(`select ${SUB} sub, sum(m.cost) cost, sum(m.in_tok + m.out_tok + m.cache_read + m.cache_write) tokens, count(*) msgs from usage_msgs m where m.ts > ? group by sub`, since)
    .map((x: any) => ({ id: x.sub, label: subLabel(x.sub), cost: x.cost, tokens: x.tokens, msgs: x.msgs })).sort((a: any, b: any) => b.cost - a.cost)
  const titles = new Map<string, string>()
  const sessions = [...new Set(rows.map(r => r.session).filter(Boolean))]
  for (let i = 0; i < sessions.length; i += 500) {
    const chunk = sessions.slice(i, i + 500)
    for (const t of all<any>(`select c.id, coalesce(u.title, c.title, c.first_prompt) title from conversations c left join user_state u on u.id = c.id where c.id in (${chunk.map(() => '?').join(',')})`, ...chunk))
      titles.set(t.id, String(t.title ?? '').slice(0, 90))
  }
  const scouts = await allScoutSpend(days)

  const accounts = profiles().filter(p => p.enabled || p.id === 'work').map(p => {
    const mine = rows.filter(r => r.account === p.id)
    const add = <K extends string>(m: Record<K, any>, k: K, r: any) => { const b = m[k] ??= { cost: 0, tokens: 0, msgs: 0 }; b.cost += r.cost ?? 0; b.tokens += r.tokens ?? 0; b.msgs += r.n; return b }
    const bySource: Record<string, any> = {}, byModel: Record<string, any> = {}, byProject: Record<string, any> = {}, bySession: Record<string, any> = {}, byWho: Record<string, any> = {}
    let sub = 0
    for (const r of mine) {
      add(bySource, r.source, r)
      add(byModel, r.model, r)
      add(byProject, r.cwd ? basename(r.cwd) : '(unknown)', r)
      if (r.source === 'perch') add(byWho, r.by_ ?? 'you', r)
      if (r.session) { const s = add(bySession, r.session, r); s.source = r.source; s.cwd = r.cwd; s.last = Math.max(s.last ?? 0, r.last); s.by = r.by_ }
      sub += r.sub ? (r.cost ?? 0) * (r.sub / r.n) : 0
    }
    const sc = scouts.find(s => s.account === p.id)
    if (sc?.data) bySource.scouts = { cost: sc.data.usd, tokens: 0, msgs: sc.data.runs }
    const list = (m: Record<string, any>, key = 'name') => Object.entries(m).map(([k, v]) => ({ [key]: k, ...v })).sort((a: any, b: any) => b.cost - a.cost)
    const daily: Record<number, Record<string, number>> = {}
    for (const d of days_.filter(d => d.account === p.id)) (daily[d.d] ??= {})[d.source] = d.cost
    return {
      id: p.id, label: p.label, color: p.color,
      cost: Object.values(bySource).reduce((a: number, s: any) => a + s.cost, 0),
      tokens: mine.reduce((a, r) => a + (r.tokens ?? 0), 0),
      subagentCost: sub,
      sources: list(bySource, 'source').map((s: any) => ({ ...s, label: SOURCE_LABEL[s.source] ?? s.source })),
      perchBy: list(byWho, 'by'),
      models: list(byModel, 'model'),
      projects: list(byProject, 'project').slice(0, 10),
      sessions: list(bySession, 'id').slice(0, 12).map((s: any) => ({ ...s, title: titles.get(s.id) || (s.cwd ? basename(s.cwd) : s.id.slice(0, 8)) })),
      scouts: sc?.data?.scouts.slice(0, 12) ?? [], scoutsError: sc?.error ?? null, scoutsUntracked: sc?.data?.untracked ?? 0,
      daily: Array.from({ length: days }, (_, i) => ({ day: since + i * 86400_000, ...(daily[i] ?? {}) })),
    }
  })
  const oldest = get<any>('select min(ts) t from usage_msgs')?.t ?? null
  return { days, subscription: subscription ?? null, subscriptions: subs, cost: accounts.reduce((a, x) => a + x.cost, 0), accounts, scan: { ...spendScan }, oldest }
}
