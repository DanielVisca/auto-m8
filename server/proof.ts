// Production proof: is a merged PR not just live, but shown to work? The scorecard is built and
// kept on the PR by PostHog (the "prod scout evidence" workflow, fed by the
// prod walkthrough and blast-radius scouts), so it keeps moving while perch is off. perch only
// reads it back from the PR's `<!-- pr-proof ... -->` comment for the Railyard and projects.
//
// Five checks, each pass | concern | no_signal | pending | n_a:
//   live (prod runs it), healthy (the perch-plan verify: metrics), used (real production use),
//   works (does what was intended: Replay Vision or a browser check), contained (no regression
//   nearby at 1h and 24h). state: proven | not_yet | concerns.
import { all, db, get, run } from './db.ts'
import { ghJson, ghOffline } from './gh.ts'

db.exec(`create table if not exists pr_proof (
  url text primary key, state text, live text, healthy text, used text, works text, contained text,
  comment_url text, updated_at integer, fetched_at integer
)`)

export const PROOF_CHECKS = ['live', 'healthy', 'used', 'works', 'contained'] as const
export type Proof = { state: string; comment_url: string | null; updated_at: number | null } & Record<(typeof PROOF_CHECKS)[number], string>

// The marker line the workflow writes at the end of the scorecard comment.
export function parseProof(body: string): Omit<Proof, 'comment_url' | 'updated_at'> | null {
  const m = body.match(/<!--\s*pr-proof\s+([^>]*?)-->/)
  if (!m) return null
  const kv = Object.fromEntries([...m[1].matchAll(/(\w+)=([\w-]+)/g)].map(x => [x[1], x[2]]))
  if (!kv.state) return null
  return { state: kv.state, live: kv.live ?? 'pending', healthy: kv.healthy ?? 'pending', used: kv.used ?? 'pending', works: kv.works ?? 'pending', contained: kv.contained ?? 'pending' }
}

export const proofOf = (url: string): Proof | null => get<any>('select * from pr_proof where url = ?', url) ?? null

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
// Merged PostHog/posthog PRs from the last 10 days (the scouts only cover that repo), not yet
// settled. A proven or concerns scorecard is re-read daily; one still moving every 20 minutes.
function due(now: number) {
  return all<any>(`select w.url, p.state, p.fetched_at from shepherd_watch w left join pr_proof p on p.url = w.url
    where w.merged_at > ? and w.url like 'https://github.com/PostHog/posthog/pull/%'`, now - 10 * DAY)
    .filter(r => !r.fetched_at || now - r.fetched_at > (r.state === 'proven' || r.state === 'concerns' ? DAY : 20 * MIN))
    .slice(0, 25)
}

export async function refreshProof(now = Date.now()) {
  if (ghOffline()) return
  for (const r of due(now)) {
    const m = r.url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
    if (!m) continue
    try {
      const comments = await ghJson<any[]>(['api', '--paginate', '--slurp', `repos/${m[1]}/${m[2]}/issues/${m[3]}/comments?per_page=100`])
      const card = comments.flat().filter((c: any) => (c.body ?? '').includes('<!-- pr-proof ')).at(-1)
      const p = card ? parseProof(card.body) : null
      run(`insert into pr_proof (url, state, live, healthy, used, works, contained, comment_url, updated_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(url) do update set state = excluded.state, live = excluded.live, healthy = excluded.healthy, used = excluded.used,
           works = excluded.works, contained = excluded.contained, comment_url = excluded.comment_url, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at`,
        r.url, p?.state ?? null, p?.live ?? null, p?.healthy ?? null, p?.used ?? null, p?.works ?? null, p?.contained ?? null,
        card?.html_url ?? null, card ? Date.parse(card.updated_at) : null, now)
    } catch (e) { console.error('proof', r.url, (e as Error).message) }
  }
}

export function startProof() {
  const tick = () => refreshProof().catch(e => console.error('proof', e))
  setTimeout(tick, 45_000)
  setInterval(tick, 10 * MIN).unref?.()
}
