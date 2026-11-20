// Comparing conversations before deciding to link or consolidate them: what each one is, side by
// side, plus Claude's judgement of whether they are the same work. Confident "same work" groups
// are linked automatically (archiving stays your decision); confident "different" ones drop out.
import { existsSync, readFileSync } from 'node:fs'
import { ephemeral } from './chat.ts'
import { link, links } from './context.ts'
import { detail } from './conversations.ts'
import { all, get, run } from './db.ts'
import { settings } from './settings.ts'
import { toItems, itemsOf } from './transcript.ts'

function ends(path: string | null) {
  if (!path || !existsSync(path)) return { first: '', last: '' }
  const items = itemsOf(path)
  const first = items.find(i => i.kind === 'user') as any
  let last = ''
  for (let i = items.length - 1; i >= 0 && !last; i--) {
    const it: any = items[i]
    if (it.kind === 'assistant') last = it.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  }
  // Drop machine-only lines (the search agent's hidden meta and scope markers).
  const clean = (t: string) => t.replace(/<!--perch[\s\S]*?-->/g, '').replace(/^Scope:.*$/gm, '').trim()
  return { first: clean(String(first?.text ?? '')).slice(0, 1200), last: clean(last).slice(-1500) }
}

export function compare(ids: string[]) {
  const convs = ids.map(id => {
    const c = detail(id)
    if (!c) return null
    const e = ends(c.path)
    const prs = all<any>(`select cp.url, cp.created, p.number, p.title, p.state, p.draft, p.checks, p.review from conversation_prs cp left join prs p on p.url = cp.url where cp.conversation_id = ?`, id)
    return {
      id, title: c.title ?? c.first_prompt, source: c.source, origin: c.origin, cwd: c.cwd, branch: c.branch, started_at: c.started_at, updated_at: c.updated_at,
      messages: c.messages, effective: c.effective, labels: c.labels, url: c.url, slack_url: c.slack_url, prs, first: e.first || c.first_prompt || '', last: e.last || c.summary || '',
    }
  }).filter(Boolean) as any[]
  const linked = all<any>(`select a, b, kind from links where a in (${ids.map(() => '?').join(',')}) and b in (${ids.map(() => '?').join(',')})`, ...ids, ...ids)
  const verdict = get<any>('select data from briefs where day = ?', `judge:${[...ids].sort().join(',')}`)
  return { conversations: convs.sort((a, b) => b.updated_at - a.updated_at), linked, verdict: verdict ? JSON.parse(verdict.data) : null }
}

const PROMPT = `Decide whether these agent conversations are the same piece of work, related work, or different things that only look alike. Look at what each was asked, where it ended, the repo/branch, PRs and dates.
Reply with ONLY JSON: {"verdict": "same" | "related" | "different", "confidence": 0.0-1.0, "why": "one or two sentences a person can check", "keep": "id of the one to keep working in if same (usually the most complete or most recent), else empty", "notes": {"<id>": "what is unique about this one, a few words"}}`

export function judge(ids: string[]): Promise<any> {
  const { conversations } = compare(ids)
  const text = conversations.map(c => `### ${c.id}\nTitle: ${c.title}\nSource: ${c.source}${c.origin ? ` (${c.origin})` : ''} · ${c.cwd ?? ''}${c.branch ? ' @' + c.branch : ''} · started ${new Date(c.started_at).toISOString().slice(0, 16)} · last active ${new Date(c.updated_at).toISOString().slice(0, 16)} · ${c.messages} messages · ${c.effective}\nPRs: ${c.prs.map((p: any) => `#${p.number ?? p.url.split('/').pop()} ${p.state ?? ''}`).join(', ') || 'none'}\nAsked: ${c.first.slice(0, 700)}\nEnded: ${c.last.slice(-700)}`).join('\n\n')
  return new Promise(resolve => {
    let out = ''
    ephemeral(['-p', `${PROMPT}\n\n${text}`, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
      if (ev.type === 'result') out = String(ev.result ?? '')
      if (ev.type !== 'perch_done') return
      let v: any = null
      try { v = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) } catch {}
      if (v) run('insert into briefs (day, created_at, data) values (?, ?, ?) on conflict(day) do update set created_at = excluded.created_at, data = excluded.data', `judge:${[...ids].sort().join(',')}`, Date.now(), JSON.stringify({ ...v, at: Date.now() }))
      resolve(v ?? { error: 'unreadable reply' })
    })
  })
}

// Links a group: every other conversation points at the one to keep.
export function linkGroup(ids: string[], keep?: string, note = 'linked after comparing') {
  const k = keep && ids.includes(keep) ? keep : ids[0]
  for (const id of ids) if (id !== k) link(id, k, 'related', note)
  return k
}

// Called for each new consolidate suggestion: judge it, and act only when confident.
export async function judgeSuggestion(suggestionId: string, ids: string[]) {
  const v = await judge(ids)
  if (!v || v.error) return
  const s = get<any>('select * from suggestions where id = ?', suggestionId)
  if (!s || s.status !== 'open') return
  const payload = { ...JSON.parse(s.payload ?? '{}'), verdict: v.verdict, confidence: v.confidence, why: v.why, judgedKeep: v.keep }
  if (v.verdict === 'different' && v.confidence >= 0.8) {
    run(`update suggestions set status = 'dismissed', payload = ? where id = ?`, JSON.stringify({ ...payload, auto: 'dismissed: different work' }), suggestionId)
  } else {
    if ((v.verdict === 'same' || v.verdict === 'related') && v.confidence >= 0.8) { linkGroup(ids, v.keep, `${v.verdict} work (autopilot, ${Math.round(v.confidence * 100)}% sure)`); payload.auto = 'linked automatically' }
    run('update suggestions set payload = ? where id = ?', JSON.stringify(payload), suggestionId)
  }
}

void links
