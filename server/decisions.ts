// Answering a decision: the answer goes back where the work is, so it carries on without you
// opening anything else. Shepherd decisions also act on the shepherd directly.
import { send } from './chat.ts'
import { all, get, run } from './db.ts'
import { decision, dueDecisions, markAnswered, markAuto, recommendedOption, type Decision } from './decisionstore.ts'
import { askMe, settings } from './settings.ts'
import { fixFinding } from './selffix.ts'

export * from './decisionstore.ts'

const say = (title: string, answer: string, extra = '') =>
  `Decision from the user on "${title}": ${answer}.${extra ? ` ${extra}` : ''}
Carry on from here without asking again. Make any further choices yourself and say what you chose in one line; don't end on a question.`

// Perch decided it (low stakes, or you didn't answer in time): what the owning conversation hears.
const sayAuto = (d: Decision, answer: string | null) => {
  const age = Date.now() - d.created_at > 6 * 3600_000 ? ` This was raised ${Math.round((Date.now() - d.created_at) / 3600_000)}h ago: check it still applies before acting.` : ''
  const why = (d.stakes === 'low' ? 'Mothership decided this one without asking the user (low stakes)'
    : !askMe() ? 'the user has asked not to be asked, so Mothership went with the recommendation'
    : `the user didn't answer within ${Math.round(((d.auto_at ?? Date.now()) - d.created_at) / 3600_000 * 10) / 10}h, so Mothership went with the recommendation`) + age
  return answer
    ? `Decision on "${d.title}": ${answer} (${why}). Carry on with it. If it turns out wrong or risky once you're in it, pick the safer reversible path and say so in one line; only raise ask_decision with stakes=high for something irreversible, outward-facing or costly.`
    : `Decision on "${d.title}": ${why}, with no option to pick, so it's yours. If a stakes=high decision on the same thing is already open for the user, wait for that one instead. Otherwise decide it with your own judgement: take the path that keeps the work moving and is easiest to undo, and say in one line what you chose. Only if it truly needs the user (an approval only they can give, a merge they must time, money or people outside the team) raise ask_decision with stakes=high, options and your recommendation.`
}

// You change your mind about something perch decided for you: the conversation hears the override.
function override(d: Decision, a: string) {
  markAnswered(d.id, a)
  const target = d.conversation_id && get<any>(`select 1 from conversations where id = ? and source != 'posthog-task'`, d.conversation_id) ? d.conversation_id : null
  if (target) send({ id: target, prompt: `The user changed the decision on "${d.title}": ${a} (Mothership had picked "${d.answer}"). Undo what you did for the old choice if needed, then carry on with this one.`, resume: true })
  return { ok: true, sentTo: target }
}

export function answerDecision(id: string, answer: string, auto = false) {
  const d = decision(id)
  if (!d) throw new Error('unknown decision')
  if (d.status === 'auto' && !auto && answer.trim() && answer.trim() !== d.answer) return override(d, answer.trim())
  if (d.status !== 'open') return { ok: true, already: d.status }
  const a = answer.trim()
  if (auto) markAuto(id, a); else markAnswered(id, a)
  const w = d.url ? get<any>('select * from shepherd_watch where url = ?', d.url) : null
  let extra = ''
  if (w && /^gate:/.test(d.key) && /cleared/i.test(a)) run(`update shepherd_watch set stage = case when stage in ('failed', 'blocked') then 'deploying' else stage end, enabled = 1, stopped_at = null, paused_reason = null, verify_attempts = 0, awaiting = null, verify_due_at = ? where url = ?`, Date.now(), d.url)
  if (w && /^gate:/.test(d.key) && /draft/i.test(a)) extra = `Find who can clear this blocker (the environment's required reviewers, the CODEOWNERS team, or whoever approved the last release) and draft the ask with the perch draft_slack_message tool. Do not send or post anything yourself.`
  if (w && /^unverified:/.test(d.key) && /again/i.test(a)) run(`update shepherd_watch set stage = 'deploying', enabled = 1, stopped_at = null, paused_reason = null, verify_attempts = 0, verify_due_at = ?, awaiting = null where url = ?`, Date.now(), d.url)
  if (w && /^unverified:/.test(d.key) && /mark it verified/i.test(a)) run(`update shepherd_watch set stage = 'verified', enabled = 0, outcome = 'marked verified by you' where url = ?`, d.url)
  if (w && /^regression:/.test(d.key) && /merge the revert/i.test(a)) extra = 'Merge the revert PR the shepherd opened (find it in the PR comments), then confirm it deployed.'
  // An autopilot finding: fixing it starts an agent; either way the old suggestion card closes.
  if (/^autopilot:/.test(d.key)) {
    const sug = get<any>(`select id from suggestions where lower(substr(title, 1, 160)) = ? and status = 'open'`, d.key.slice('autopilot:'.length))
    const fix = /^fix it for me$/i.test(a)
    if (sug) run(`update suggestions set status = ? where id = ?`, fix ? 'accepted' : 'dismissed', sug.id)
    if (fix) { const id = fixFinding(d.title, d.context ?? '', d.url); run('update decisions set conversation_id = ? where id = ?', id, d.id); return { ok: true, sentTo: id } }
    return { ok: true, sentTo: null }
  }
  // Where the answer goes: the owning conversation, else the PR's shepherd. Cloud tasks can't be resumed from here.
  const target = [d.conversation_id, w?.conversation_id].find(c => c && get<any>(`select 1 from conversations where id = ? and source != 'posthog-task'`, c))
  const quiet = /^(leave it|i cleared it|mark it verified|verify it again)$/i.test(a) && !extra
  if (target && !quiet) send({ id: target, prompt: auto ? `${sayAuto(d, a || null)}${extra ? ` ${extra}` : ''}` : say(d.title, a, extra), resume: true })
  return { ok: true, sentTo: quiet ? null : target ?? null }
}

// Perch decides what's due: low-stakes ones at once, big ones once you've had your window. A couple
// a minute, so a backlog doesn't wake a dozen agents at the same moment, and "fix it for me" agents
// capped per day (the rest wait for tomorrow).
export function decideDue(now = Date.now()) {
  let n = 0
  for (const d of dueDecisions(now)) {
    if (n >= 2) break
    let a = recommendedOption(d)
    if (/^autopilot:/.test(d.key) && /^fix it for me$/i.test(a ?? '')) {
      const today = all<any>(`select 1 from decisions where key like 'autopilot:%' and status = 'auto' and answer like 'fix it%' and answered_at > ?`, now - 86400_000).length
      if (today >= (settings.decisions?.autoFixesPerDay ?? 3)) { run('update decisions set auto_at = ? where id = ?', now + 6 * 3600_000, d.id); continue }
    }
    try { answerDecision(d.id, a ?? '', true) } catch (e) { console.error('auto-decide', d.id, e) }
    n++
  }
  return n
}
