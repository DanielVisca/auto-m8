// One perch chat writing into another: a "driver" chat (a monitor, a the user pair) keeps the user's
// other conversations going. Every message carries a marker line, so the receiving agent knows the
// user didn't type it, and the chat renders it as agent-sent (it survives reloads because it lives
// in the transcript itself, not in a side table).
import { chats, send } from './chat.ts'
import { get, run } from './db.ts'
import { liveSessions } from './presence.ts'
import { watch } from './orchestra.ts'

export { AGENT_MARK } from '../shared/messageOrigin.ts'

export const titleFor = (id: string) =>
  get<{ t: string }>(`select coalesce(u.title, c.title, c.first_prompt, '') as t from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)?.t?.replace(/["\n]/g, ' ').slice(0, 80) ?? ''

export const marked = (from: string, message: string) => `[perch: sent by an agent from perch://${from}${titleFor(from) ? ` "${titleFor(from)}"` : ''}. Not typed by the user.]\n\n${message}`

export function relay(input: { from: string; to: string; message: string; reportBack?: boolean }) {
  const from = String(input.from || ''), to = String(input.to || '').replace(/^perch:\/\//, ''), message = String(input.message ?? '').trim()
  if (!from) throw new Error('Pass your own conversation_id as from.')
  if (!to) throw new Error('Pass the conversation to write to.')
  if (from === to) throw new Error("That's your own conversation.")
  if (!message) throw new Error('The message is empty.')
  const row = get<{ source: string }>('select source from conversations where id = ?', to)
  if (!row && !chats.has(to)) throw new Error(`No conversation ${to}. Find it with search_conversations or recent_activity.`)
  if (row && row.source !== 'claude') throw new Error(`perch can't write into a ${row.source} conversation, only Claude Code ones.`)
  // Open in a terminal right now: resuming it from perch would fork its history under the user.
  if (!chats.has(to) && liveSessions().some(s => s.session === to)) throw new Error('That conversation is open in a terminal right now; writing to it from perch would fork it. Tell the user instead.')
  send({ id: to, prompt: marked(from, message), resume: true })
  run('insert or ignore into links (a, b, kind, note, created_at) values (?, ?, ?, ?, ?)', from, to, 'drives', 'agent-sent messages', Date.now())
  const ours = chats.has(from) || !!get('select 1 from perch_started where id = ?', from)
  // The reply comes back through the owner's inbox (batched with everything else it watches).
  if (input.reportBack !== false && ours && !get('select 1 from watches where owner = ? and target = ? and active = 1', from, to)) watch({ owner: from, targets: [to], events: ['turn_end', 'asked', 'error'] })
  return { ok: true, title: titleFor(to), reportBack: input.reportBack !== false && ours }
}
