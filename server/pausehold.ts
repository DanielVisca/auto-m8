// The part of "pause all" that chat.ts needs. No imports from chat.ts, so there is no cycle.
// While autonomy is off, anything an automation tries to start is recorded here and not started.
// Your own messages (by: 'you') and retries always go through.
import { all, db, run } from './db.ts'
import { autonomyOn } from './settings.ts'

db.exec(`create table if not exists pause_held (
  id integer primary key autoincrement, at integer not null, by text, conversation_id text, prompt text)`)

export const isPaused = () => !autonomyOn()

// By is the automation that sent it. Unset means an agent's own call; those are held too, because
// an agent talking to another agent spends tokens just the same. 'you' is you.
export function shouldHold(o: { by?: string; retry?: boolean; resent?: boolean; manual?: boolean }) {
  return isPaused() && o.by !== 'you' && !o.manual && !o.retry && !o.resent
}

export function hold(o: { by?: string; id?: string; prompt: string }) {
  run('insert into pause_held (at, by, conversation_id, prompt) values (?, ?, ?, ?)', Date.now(), o.by ?? 'agent', o.id ?? null, o.prompt.slice(0, 300))
  run('delete from pause_held where id not in (select id from pause_held order by id desc limit 500)')
}

export const held = () => all<{ id: number; at: number; by: string; conversation_id: string | null; prompt: string }>('select * from pause_held order by id desc limit 100')
export const clearHeld = () => run('delete from pause_held')
