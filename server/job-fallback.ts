// Text-only jobs can safely retry on another provider. Keep failed/partial answers out
// of JSON consumers, and never let cancellation launch another attempt.
type Event = Record<string, any>
export type TextJob = (emit: (ev: Event) => void) => () => void
export function runTextJobs(jobs: TextJob[], emit: (ev: Event) => void) {
  let cancelled = false, stop: (() => void) | undefined
  const attempt = (index: number) => {
    const events: Event[] = []
    let failed = false, finished = false, answered = false
    const cancel = jobs[index](ev => {
      if (cancelled || finished) return
      events.push(ev)
      if (ev.type === 'result') { answered = typeof ev.result === 'string' && !!ev.result.trim(); if (ev.is_error) failed = true }
      if (ev.type !== 'perch_done') return
      finished = true
      failed ||= !answered || !!ev.code || !!ev.error
      if (failed && index + 1 < jobs.length) attempt(index + 1)
      else for (const event of events) emit(event)
    })
    if (!finished) stop = cancel
  }
  attempt(0)
  return () => { cancelled = true; stop?.() }
}
