// A conversation that names a PR belongs with the others about that PR. Starting a chat with a PR link
// reuses the conversation that opened the PR (or pulls the related ones in as context), and conversations
// that share a PR are linked on their own, so nobody has to say "see the other chat".
import { all, get, run } from './db.ts'
import { isAutomated } from './conversations.ts'
import { link } from './context.ts'

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const RECENT = 14 * 86_400_000
export const prUrls = (text: string) => [...new Set(text.match(PR_RE) ?? [])]

type Hit = { id: string; url: string; created: number; updated_at: number; source: string; origin: string | null; labels: string | null }

// Your own conversations about these PRs, newest first, the one that opened the PR ahead of the rest.
export function conversationsAboutPrs(urls: string[], exclude = ''): Hit[] {
  if (!urls.length) return []
  const rows = all<Hit>(`select c.id, cp.url, cp.created, c.updated_at, c.source, c.origin,
      (select group_concat(label) from labels where id = c.id) labels
    from conversation_prs cp join conversations c on c.id = cp.conversation_id
    where cp.url in (${urls.map(() => '?').join(',')}) and c.id != ?
    order by cp.created desc, c.updated_at desc`, ...urls, exclude)
  return rows.filter(r => !isAutomated(r) && !/(^|,)(shepherd|search)(,|$)/.test(r.labels ?? ''))
}

export type Plan = { reuse: string | null; contextIds: string[]; urls: string[]; status: string }

// For a new chat: where should this prompt go? One PR link and a conversation of yours that opened it,
// still warm and resumable on this Mac: continue that one. Otherwise start fresh but with the related
// conversations pulled in and linked.
export function planForPrompt(prompt: string, now = Date.now()): Plan {
  const urls = prUrls(prompt)
  const hits = conversationsAboutPrs(urls)
  const status = urls.map(u => {
    const p = get<any>('select number, title, state, draft, review, checks from prs where url = ?', u)
    return p ? `${u}: #${p.number} "${p.title}", ${p.draft ? 'draft' : String(p.state).toLowerCase()}, checks ${p.checks ?? '?'}, review ${p.review ?? 'none'}` : ''
  }).filter(Boolean).join('\n')
  const opener = urls.length === 1 ? hits.find(h => h.created && h.source === 'claude' && now - h.updated_at < RECENT) : undefined
  const ids = [...new Set(hits.map(h => h.id))]
  return { reuse: opener?.id ?? null, contextIds: opener ? [] : ids.slice(0, 3), urls, status }
}

// Link a conversation to the others that share a PR with it (automated runs and bulk mentions excluded).
export function autolinkPr(id: string, url: string) {
  for (const o of conversationsAboutPrs([url], id).slice(0, 5)) {
    if (get('select 1 from links where (a = ? and b = ?) or (a = ? and b = ?)', id, o.id, o.id, id)) continue
    link(id, o.id, 'related', `both about ${url.replace('https://github.com/', '').replace('/pull/', '#')}`)
  }
}
