// The request-time gate is cheap and deterministic. The working agent scopes a selected task
// before launching it, so racers get the actual repo, context and a focused acceptance check.
import { createHash, randomUUID } from 'node:crypto'
import { all, db, get, run } from './db.ts'
import { autonomyOn, settings } from './settings.ts'
import { learningGates, type UsageSnapshot } from './learning-budget.ts'

db.exec(`create table if not exists race_candidates (
  id text primary key, conversation_id text not null, fingerprint text not null, prompt text not null,
  reason text not null, status text not null, outcome text, run_id text, created_at integer not null,
  started_at integer, delivered_at integer, unique(conversation_id, fingerprint)
);
create index if not exists race_candidates_created on race_candidates(created_at)`)

export const autoConfig = () => ({ enabled: true, perDay: 24, maxConcurrent: 2, cooldownHours: 0.5,
  models: ['claude-opus-5-5', 'codex:gpt-6-astra'], ...(settings as any).raceAuto })
const HOUR = 3_600_000
const noRace = /\b(?:don['’]?t|do not|no|without|skip|avoid)\s+(?:a\s+|the\s+|any\s+|model\s+|automatic\s+)*(?:races?|racing|multi[- ]model)\b|\bsingle (?:agent|model)\b|\b(?:do|handle) (?:it|this) yourself\b/i

export function candidateReason(prompt: string): string | null {
  // Only the new request, never pasted code, old conversation context or tool output.
  const p = prompt.replace(/```[\s\S]*?```/g, '').replace(/^>.*$/gm, '').trim()
  if (p.length < 50 || p.length > 12_000 || noRace.test(p)) return null
  if (/\b(urgent|asap|incident|outage|hotfix|production is down|quick(?:ly)?|just (?:rename|change|update)|typo|copy edit)\b/i.test(p)) return null
  if (/\b(?:race (?:this|these|models)|model race|compare (?:the )?models)\b/i.test(p)) return null // explicit races already have a tool
  if (!/\b(implement|build|fix|debug|refactor|optimi[sz]e|redesign|add|create|replace|rewrite)\b/i.test(p)) return null
  if (/^\s*(?:what|why|how|explain|summari[sz]e|review|audit)\b/i.test(p)) return null
  if (/\b(?:build|create|write|draft|make)\s+(?:(?:a|an|the)\s+)?(?:report|document|presentation|email|message)\b/i.test(p)) return null
  if (!/\b(code|repo(?:sitory)?|function|module|component|api|endpoint|server|client|parser|cache|queue|worker|scheduler|query|database|tests?|widget|ingestion|pipeline|algorithm|service|perch)\b/i.test(p)) return null
  const reasons: string[] = []
  if (/\b(race condition|deadlock|concurren\w*|idempot\w*|retry|retries|cancell?ation|ordering|corrupt\w*|duplicate\w*|intermittent)\b/i.test(p)) reasons.push('correctness across tricky cases')
  if (/\b(performance|latency|throughput|bottleneck|optimi[sz]\w*|memory|faster|slow)\b/i.test(p)) reasons.push('measurable performance tradeoffs')
  if (/\b(refactor|redesign|architecture|algorithm|parser|scheduler|state machine|alternative\w*|trade.?offs?)\b/i.test(p)) reasons.push('competing implementation approaches')
  if (p.length >= 250 && /\b(tests?|regression|benchmark|acceptance|must|should)\b/i.test(p)) reasons.push('substantial task with checkable requirements')
  return reasons.length ? reasons.join('; ') : null
}

type Candidate = { id: string; conversation_id: string; prompt: string; reason: string; status: string; outcome: string | null; run_id: string | null; created_at: number }
export const candidate = (id: string) => get<Candidate>('select * from race_candidates where id = ?', id)
export const pendingCandidate = (requester: string) => get<Candidate>(`select * from race_candidates where conversation_id = ? and status = 'selected' and created_at > ? order by created_at desc limit 1`, requester, Date.now() - HOUR)
export function raceCapacityError(models = 2): string | null {
  if (!get("select 1 from sqlite_master where type = 'table' and name = 'race_runs'")) return null
  const running = get<{ n: number }>("select count(*) n from race_runs where status = 'running'")!.n
  const limit = autoConfig().maxConcurrent
  if (running >= limit) return `Race concurrency limit reached (${limit} at a time).`
  const contestants = get<{ n: number }>(`select count(*) n from race_entries e join race_runs r on r.id = e.run_id where r.status = 'running'`)!.n
  if (contestants + models > 6) return 'Race worktree limit reached (6 contestants at a time).'
  return null
}
export function autoGate(now = Date.now(), except?: string, usage?: UsageSnapshot): string | null {
  const cfg = autoConfig()
  if (!cfg.enabled || !autonomyOn()) return 'Automatic races are off.'
  const capacity = raceCapacityError()
  if (capacity) return capacity
  const quota = learningGates(cfg.models, usage, now)[0]
  if (quota) return `Automatic races paused: ${quota.reason}`
  const used = get<{ n: number }>(`select count(*) n from race_candidates where id != ? and
    (started_at >= ? or (status = 'selected' and created_at >= ?))`, except ?? '', now - 24 * HOUR, now - HOUR)?.n ?? 0
  if (used >= cfg.perDay) return `Automatic race limit reached (${cfg.perDay} per 24 hours).`
  return null
}

export function selectRace(input: { conversation: string; prompt: string; by?: string; retry?: boolean; resent?: boolean; busy?: boolean; profile?: boolean; mode?: string }, now = Date.now()): Candidate | null {
  if (input.by !== 'you' || input.retry || input.resent || input.profile || process.env.PERCH_RACE || process.env.PERCH_SHADOW) return null
  const fingerprint = createHash('sha256').update(input.prompt.trim()).digest('hex')
  if (get('select 1 from race_candidates where conversation_id = ? and fingerprint = ?', input.conversation, fingerprint)) return null
  // A new user instruction invalidates a pending brief, including an opt-out or changed scope.
  run(`update race_candidates set status = 'skipped', outcome = 'Superseded by a newer user message.' where conversation_id = ? and status = 'selected'`, input.conversation)
  const reason = candidateReason(input.prompt)
  if (!reason) return null
  const recent = get(`select 1 from race_candidates where conversation_id = ? and created_at > ? and (started_at is not null or status = 'selected')`, input.conversation, now - autoConfig().cooldownHours * HOUR)
  const active = get("select 1 from sqlite_master where type = 'table' and name = 'race_runs'") && get("select 1 from race_runs where requester = ? and status = 'running'", input.conversation)
  const blocked = input.busy ? 'Already working on this conversation.' : input.mode === 'plan' ? 'Read-only planning mode.' : active ? 'This conversation already has a running race.' : autoGate(now) ?? (recent ? 'Conversation race cooldown.' : null)
  const id = randomUUID()
  run('insert into race_candidates (id, conversation_id, fingerprint, prompt, reason, status, outcome, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)', id, input.conversation, fingerprint, input.prompt.slice(0, 12_000), reason, blocked ? 'skipped' : 'selected', blocked, now)
  return blocked ? null : candidate(id)!
}

export function raceInstruction(c: Candidate) {
  return `\n\n<perch-auto-race>\nPerch selected this request for an automatic model race: ${c.reason}. The user has authorized automatic races; don't ask them to remember or approve the feature. Before editing, do a short read-only scoping pass. Find the repo, gather the necessary context and choose a focused test/benchmark command. Then call perch race action=start with cwd, a self-contained task (including prior constraints and acceptance criteria), and verify. If the tool exposes auto_candidate, pass "${c.id}"; older tool versions are linked to this candidate by conversation automatically. Do not duplicate the implementation yourself while it runs. Perch will resume this chat with the final branch and evidence. Inspect that result, integrate it if it still fits the user's latest request, run the focused checks, and finish the original task. If unsuitable after scoping (e.g. trivial, external-only, missing context, dependent on uncommitted work), call race action=skip with auto_candidate and reason, then continue normally. Older tools without skip can POST JSON to http://127.0.0.1:${process.env.PERCH_PORT ?? settings.port}/api/race/skip with auto_candidate="${c.id}", requester="${c.conversation_id}" and reason. If starting fails, continue normally. Only local work is raced; fetch needed read-only context first.\n</perch-auto-race>`
}

export function skipCandidate(id: string, requester: string, reason: string) {
  const c = candidate(id)
  if (!c || c.conversation_id !== requester) return { error: 'No automatic candidate for this conversation.' }
  if (c.status !== 'selected') return { error: `Candidate is already ${c.status}.` }
  if (!reason.trim()) return { error: 'Give the reason for skipping.' }
  run(`update race_candidates set status = 'skipped', outcome = ? where id = ?`, reason.slice(0, 800), id)
  return { ok: true }
}

export function validateCandidate(id: string, requester?: string, now = Date.now()): string | null {
  const c = candidate(id)
  if (!c || !requester || c.conversation_id !== requester) return 'No automatic candidate for this conversation.'
  if (c.status !== 'selected') return `Automatic candidate is already ${c.status}.`
  if (now - c.created_at >= HOUR) return 'Automatic candidate expired; continue the task normally.'
  return autoGate(now, id)
}

export function startedCandidate(id: string, runId: string) {
  run(`update race_candidates set status = 'started', run_id = ?, started_at = ? where id = ? and status = 'selected'`, runId, Date.now(), id)
}

export function autoInsights() {
  run(`update race_candidates set status = 'skipped', outcome = 'Scoping window expired; no automatic race started.' where status = 'selected' and created_at < ?`, Date.now() - HOUR)
  return { ...autoConfig(), pausedByAutonomy: !autonomyOn(), subscriptionGates: learningGates(autoConfig().models), recent: all<any>('select * from race_candidates order by created_at desc limit 20') }
}

// Durable completion outbox. Retried on restart; failures return the original task to its agent too.
// The callback enqueues synchronously before we mark delivered, so normal restarts don't lose it.
export function deliverRaceResults(send: (id: string, message: string) => void) {
  const rows = all<any>(`select c.id candidate_id, c.conversation_id, r.* from race_candidates c join race_runs r on r.id = c.run_id
    where c.status = 'started' and r.status in ('done', 'error')`)
  for (const r of rows) {
    let check: any = null
    try { check = JSON.parse(r.final_verify) } catch {}
    const usable = r.status === 'done' && r.final_branch && check?.ok === true
    const message = `Automatic model race ${r.id} ${usable ? 'finished' : 'needs recovery'}.\nOriginal task: ${r.task}\nRepository: ${r.top}\n${usable ? `Combined solution: ${r.final_branch}\nReport: ${r.report}\nThe configured check passed.` : `Error/check: ${r.error || check?.output || 'No passing final check.'}\nDo not treat this result as verified.`}\nRead race action=status id=${r.id} for the evidence. Check the user's latest instructions before applying anything; skip integration if the task was canceled or superseded. Otherwise inspect the final diff, integrate useful work without overwriting existing edits, validate, and finish the original task. Don't start another race for this message.`
    try {
      send(r.conversation_id, message)
      run(`update race_candidates set status = 'delivered', outcome = ?, delivered_at = ? where id = ?`, usable ? 'Combined solution returned to the chat.' : 'Failure returned to the chat for recovery.', Date.now(), r.candidate_id)
    } catch {} // keep the outbox row pending
  }
}
