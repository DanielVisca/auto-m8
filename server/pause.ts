// Pause all: one switch that stops every agent and scout perch runs on its own, a page that shows
// exactly what is on and what is held, and one button to bring it all back.
//
// It extends the autonomy switch (settings.autonomy.enabled) that the shepherd, autopilot, evolve,
// lifecycle and races already follow, and covers the rest: routines, follow-ups, watch events,
// stall nudges, titles, shadow replays, and anything an automation tries to send.
// Your own chats are never touched.
import { all } from './db.ts'
import { interrupt, runningChats, send } from './chat.ts'
import { settings, updateSettings } from './settings.ts'
import { clearHeld, held, isPaused } from './pausehold.ts'
import './routines.ts' // the routines table
import './shepherdstore.ts' // shepherd_watch
import './orchestra.ts' // watches and inbox
import './cloud.ts' // cloud_leases

export { isPaused }

const RESUME_PROMPT = 'auto-m8 was paused to save tokens and is running again. This chat was interrupted by the pause. Check where things stand now (files, PRs, CI) and carry on, or say if it is no longer needed.'

type Row = { id: string; by: string | null; title: string | null }
const titled = (ids: string[]) => ids.length ? all<Row>(`select c.id, p.by, coalesce(u.title, c.title, c.first_prompt) title from conversations c
  left join perch_started p on p.id = c.id left join user_state u on u.id = c.id where c.id in (${ids.map(() => '?').join(',')})`, ...ids) : []

// Running chats an automation started: shepherds, helpers, routines, scouts' local partners.
// A chat you started (by: 'you'), or a terminal session perch never started, is left alone.
function automated() {
  const running = runningChats().filter(c => c.state === 'running').map(c => c.id)
  const by = new Map(all<{ id: string; by: string | null }>('select id, by from perch_started').map(r => [r.id, r.by]))
  return running.filter(id => by.has(id) && by.get(id) !== 'you').map(id => ({ id, by: by.get(id) ?? 'agent' }))
}

export function pauseAll(reason = 'paused by you') {
  const stopping = automated()
  updateSettings({ autonomy: { enabled: false, pausedAt: Date.now(), reason, interrupted: stopping.map(s => s.id) } })
  for (const s of stopping) { try { interrupt(s.id) } catch (e) { console.error('[pause] interrupt', s.id, e) } }
  return overview()
}

export function resumeAll(opts: { restart?: boolean } = {}) {
  const ids = (settings.autonomy.interrupted ?? []) as string[]
  updateSettings({ autonomy: { enabled: true, pausedAt: null, reason: null, interrupted: [] } })
  clearHeld()
  if (opts.restart !== false) for (const id of ids) { try { send({ id, prompt: RESUME_PROMPT, resume: true, by: 'perch' }) } catch (e) { console.error('[pause] resume', id, e) } }
  return overview()
}

// Everything that can spend tokens without you asking, and what the pause does to it.
export function overview() {
  const a = settings.autonomy
  const paused = isPaused()
  const now = Date.now()
  const running = automated()
  const titles = new Map(titled(running.map(r => r.id)).map(r => [r.id, r.title]))
  const interrupted = titled((a.interrupted ?? []) as string[])

  const routines = all<any>('select * from routines order by enabled desc, name')
  const shepherds = all<any>('select url, conversation_id, enabled, source from shepherd_watch where enabled = 1')
  // A watch makes an event wake its owner: the owners are the agents that keep other agents alive.
  const watches = all<any>(`select w.owner, count(*) n, group_concat(w.target, ' ') targets,
    coalesce(u.title, c.title, c.first_prompt) title, (select count(*) from inbox i where i.owner = w.owner and i.delivered_at is null) queued
    from watches w left join conversations c on c.id = w.owner left join user_state u on u.id = w.owner where w.active = 1 group by w.owner`)
  const followUps = all<any>(`select p.id, p.conversation_id, p.text, p.due_at, p.pr_url, p.status, p.attempts, coalesce(u.title, c.title, c.first_prompt) title
    from promises p join conversations c on c.id = p.conversation_id left join user_state u on u.id = c.id
    where p.status in ('open', 'waiting') order by coalesce(p.due_at, p.created_at)`)
  const cloud = all<any>(`select conversation_id, task_id, url, status, started_at from cloud_leases where status in ('cloud', 'returning')`)

  return {
    paused,
    since: paused ? a.pausedAt ?? null : null,
    reason: paused ? a.reason ?? null : null,
    // What a pause stops, in the words you would use.
    covers: [
      'Routines and scheduled scouts that run on this Mac',
      'PR shepherds (comment replies, CI fixes, merges, production checks)',
      'Follow-ups agents set for themselves',
      'Watch events that wake an agent (the board, orchestrator)',
      'Autopilot, evolve, lifecycle, automatic races, needs-me judging and stall nudges',
      'Chat titling and shadow replays',
      'Any message an automation tries to send to an agent',
    ],
    notCovered: [
      'Your own chats and anything you type',
      'Scouts that run in PostHog cloud (pause those in PostHog)',
      'Cloud tasks already handed off (they finish on their own)',
    ],
    runningNow: running.map(r => ({ ...r, title: titles.get(r.id) ?? null })),
    interrupted: interrupted.map(r => ({ id: r.id, by: r.by, title: r.title })),
    held: held(),
    routines: routines.map(r => ({ ...r, wouldRun: !!r.enabled && !!r.cron && !paused, holds: paused && !!r.enabled })),
    shepherds,
    watches,
    followUps: followUps.map(f => ({ ...f, overdue: !!f.due_at && f.due_at < now })),
    cloud,
    counts: {
      running: running.length, routines: routines.filter(r => r.enabled && r.cron).length, shepherds: shepherds.length,
      watchers: watches.length, followUps: followUps.length, held: held().length, cloud: cloud.length,
    },
  }
}
