// Slack messages agents draft and you send. Agents can't send to Slack (perch blocks their send
// tools); they read the channel or thread, write the message in your voice, and hand perch a draft
// with the messages it read. You see that context and the draft together, edit it, and send it,
// or open it as a draft in Slack. perch holds no Slack token: sending goes through your own Slack
// connector in a one-off Claude run that may call exactly one tool, with your approved text.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { ephemeral } from './chat.ts'
import { all, db, get, run } from './db.ts'
import { HOME, settings } from './settings.ts'
import { McpAuthError, needsAuthIn, startMcpLogin } from './mcplogin.ts'

db.exec(`create table if not exists slack_drafts (
  id text primary key, conversation_id text, channel_id text not null, channel_name text, thread_ts text,
  text text not null, why text, context text, permalink text, status text not null default 'draft',
  sent_link text, error text, created_at integer, updated_at integer
)`)
// A file sent with the message (e.g. a video), a draft that replies in the thread of another draft
// once that one is sent, and the sent message's ts (so replies can find it).
for (const col of ['file text', 'reply_to text', 'sent_ts text']) {
  try { db.exec(`alter table slack_drafts add column ${col}`) } catch {}
}

export type Draft = { id: string; conversation_id: string | null; channel_id: string; channel_name: string | null; thread_ts: string | null; text: string; why: string | null
  context: { author: string; text: string; ts?: string }[]; permalink: string | null; status: 'draft' | 'sending' | 'sent' | 'dismissed' | 'in-slack'; sent_link: string | null; error: string | null; created_at: number
  file: string | null; reply_to: string | null; sent_ts: string | null }

const parse = (r: any): Draft => ({ ...r, context: r.context ? JSON.parse(r.context) : [] })
export const getDraft = (id: string) => { const r = get<any>('select * from slack_drafts where id = ?', id); return r ? parse(r) : null }
export const draftsFor = (conversationId: string) => all<any>('select * from slack_drafts where conversation_id = ? order by created_at desc', conversationId).map(parse)

export function createDraft(a: { conversation_id?: string; channel_id: string; channel_name?: string; thread_ts?: string; message: string; why?: string; context?: any[]; permalink?: string; file?: string; reply_to_draft?: string }) {
  const id = randomUUID().slice(0, 12)
  const file = a.file ? String(a.file).replace(/^~(?=\/)/, HOME) : null
  if (file && (!existsSync(file) || !statSync(file).isFile())) throw new Error(`No file at ${a.file}`)
  const replyTo = a.reply_to_draft ? String(a.reply_to_draft).replace(/^draft:/, '') : null
  if (replyTo && !getDraft(replyTo)) throw new Error(`No draft ${a.reply_to_draft} to reply to`)
  const context = (Array.isArray(a.context) ? a.context : []).slice(-12).map((m: any) => ({ author: String(m.author ?? m.user ?? '?').slice(0, 60), text: String(m.text ?? '').slice(0, 1200), ts: m.ts ? String(m.ts) : undefined }))
  run(`insert into slack_drafts (id, conversation_id, channel_id, channel_name, thread_ts, text, why, context, permalink, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, a.conversation_id ?? null, String(a.channel_id), a.channel_name ? String(a.channel_name).replace(/^#/, '') : null, a.thread_ts ?? null, String(a.message), a.why ?? null, JSON.stringify(context), a.permalink ?? null, Date.now(), Date.now())
  run('update slack_drafts set file = ?, reply_to = ? where id = ?', file, replyTo, id)
  return id
}

// A one-off Claude run allowed exactly one Slack tool. Returns its final text.
// Slack reaches Claude two ways: the claude.ai connector and the Slack plugin; either may be the one
// connected. If the session starts with no Slack connected and one needing OAuth, stop there and
// start that authorization (it opens the browser) rather than let the model report it as text.
const SLACK_PREFIXES = ['mcp__claude_ai_Slack__', 'mcp__plugin_slack_slack__']
function slackCall(tool: string | string[], prompt: string): Promise<string> {
  const allowed = (Array.isArray(tool) ? tool : [tool]).flatMap(t => SLACK_PREFIXES.map(p => p + t)).join(',')
  return new Promise((resolve, reject) => {
    let out = '', stop: (() => void) | undefined, failed = false
    stop = ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', allowed],
      settings.chat.cwd, ev => {
        if (failed) return
        const pending = needsAuthIn(ev, /slack/i)
        if (pending.length && !ev.mcp_servers.some((s: any) => /slack/i.test(String(s.name)) && s.status === 'connected')) {
          failed = true
          startMcpLogin(pending[0])
          stop?.()
          return reject(new McpAuthError(pending[0], 'Slack'))
        }
        if (ev.type === 'result') out = String(ev.result ?? '')
        if (ev.type === 'perch_done') ev.code ? reject(new Error(ev.error || 'The Slack call failed.')) : resolve(out)
      }) as any
  })
}
const json = (s: string) => { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) } catch { return null } }

// You pressed Send: post exactly the approved text (with its file, if it has one).
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf' }
// The ts in a Slack message link: …/p1794441283123456 → 1794441283.123456
const tsOf = (link?: string | null) => { const m = String(link ?? '').match(/\/p(\d{10})(\d{6})/); return m ? `${m[1]}.${m[2]}` : null }

export async function sendDraft(id: string, text: string) {
  const d = getDraft(id)
  if (!d) throw new Error('That draft is gone.')
  if (d.status === 'sent') return { ok: true, link: d.sent_link }
  // A reply to another draft goes in that message's thread, so the parent has to be out first.
  let threadTs = d.thread_ts
  if (!threadTs && d.reply_to) {
    const parent = getDraft(d.reply_to)
    if (!parent?.sent_ts) throw new Error('Send the message this replies to first: it goes in that thread.')
    threadTs = parent.sent_ts
  }
  run(`update slack_drafts set status = 'sending', text = ?, error = null, updated_at = ? where id = ?`, text, Date.now(), id)
  try {
    const r = d.file ? await sendWithFile(d, text, threadTs) : await sendText(d, text, threadTs)
    run(`update slack_drafts set status = 'sent', sent_link = ?, sent_ts = ?, thread_ts = ?, error = null, updated_at = ? where id = ?`, r.link ?? null, r.ts ?? tsOf(r.link), threadTs ?? null, Date.now(), id)
    return { ok: true, link: r.link ?? null }
  } catch (e: any) {
    run(`update slack_drafts set status = 'draft', error = ?, updated_at = ? where id = ?`, String(e.message).slice(0, 300), Date.now(), id)
    throw e
  }
}

async function sendText(d: Draft, text: string, threadTs: string | null) {
  const args = { channel_id: d.channel_id, message: text, ...(threadTs ? { thread_ts: threadTs } : {}) }
  const out = await slackCall('slack_send_message', `The user reviewed and approved this Slack message. Call slack_send_message exactly once with these arguments, unchanged, character for character:
${JSON.stringify(args)}
Then reply with only JSON: {"sent": true, "link": "<the message link it returned>"} or {"sent": false, "error": "<why>"}`)
  const r = json(out)
  if (!r?.sent) throw new Error(r?.error ?? 'Slack didn’t confirm the message was sent.')
  return { link: r.link as string | undefined, ts: tsOf(r.link) }
}

// Slack's upload flow: get an upload URL, POST the bytes ourselves, then share the file to the
// channel with the text as its message, so it plays inline. Then find that message's ts.
async function sendWithFile(d: Draft, text: string, threadTs: string | null) {
  const path = d.file!
  if (!existsSync(path)) throw new Error(`The file is gone: ${path}`)
  const bytes = readFileSync(path)
  const filename = basename(path)
  const step1 = json(await slackCall('slack_get_file_upload_url', `Call slack_get_file_upload_url exactly once with ${JSON.stringify({ filename, content_length: bytes.length })}.
Then reply with only JSON: {"upload_url": "<the upload URL, byte for byte exactly as returned>", "file_id": "<the file ID>"} or {"error": "<why>"}`))
  if (!step1?.upload_url || !step1?.file_id) throw new Error(step1?.error ?? 'Slack didn’t give an upload URL.')
  const up = await fetch(step1.upload_url, { method: 'POST', headers: { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': String(bytes.length) }, body: bytes })
  if (!up.ok) throw new Error(`Slack refused the upload (${up.status}).`)
  const share = { file_id: step1.file_id, channel_id: d.channel_id, initial_comment: text, title: filename, ...(threadTs ? { thread_ts: threadTs } : {}) }
  const read = threadTs ? `slack_read_thread with {"channel_id": "${d.channel_id}", "message_ts": "${threadTs}", "limit": 5}` : `slack_read_channel with {"channel_id": "${d.channel_id}", "limit": 5}`
  const r = json(await slackCall(['slack_complete_file_upload', threadTs ? 'slack_read_thread' : 'slack_read_channel'], `The user reviewed and approved sharing this file with this message. Call slack_complete_file_upload exactly once with these arguments, unchanged, character for character:
${JSON.stringify(share)}
Then call ${read}, and find the newest message that has this file attached (or starts with the message text above). Reply with only JSON: {"sent": true, "link": "<a link to that message, or the file link>", "ts": "<that message's ts>"} or {"sent": false, "error": "<why>"}`))
  if (!r?.sent) throw new Error(r?.error ?? 'Slack didn’t confirm the file was shared.')
  return { link: r.link as string | undefined, ts: (r.ts as string | undefined) ?? tsOf(r.link) }
}

// "Open draft in Slack": put it in Slack's own drafts for that channel/thread, and open Slack there.
export async function draftInSlack(id: string, text: string) {
  const d = getDraft(id)
  if (!d) throw new Error('That draft is gone.')
  const args = { channel_id: d.channel_id, message: text, ...(d.thread_ts ? { thread_ts: d.thread_ts } : {}) }
  const out = await slackCall('slack_send_message_draft', `Create a Slack draft (do not send). Call slack_send_message_draft exactly once with these arguments, unchanged:
${JSON.stringify(args)}
Then reply with only JSON: {"ok": true, "channel_link": "<the channel_link it returned>"} or {"ok": false, "error": "<why>"}`)
  const r = json(out)
  if (!r?.ok) throw new Error(r?.error === 'attached_draft_exists' ? 'Slack already has a draft in that channel: send or delete it there first.' : r?.error ?? 'Slack didn’t create the draft.')
  run(`update slack_drafts set status = 'in-slack', text = ?, updated_at = ? where id = ?`, text, Date.now(), id)
  return { ok: true, link: slackAppLink(r.channel_link) ?? slackAppLink(d.permalink) ?? r.channel_link ?? d.permalink }
}

// Open Slack's desktop app directly: an https link goes through the browser first, which leaves a
// stray "Open Slack?" tab behind. Slack returns either app.slack.com/client/T…/C… or
// <workspace>.slack.com/archives/C…, which has no team id, so known workspaces are mapped here.
const TEAMS: Record<string, string> = {}
export function slackAppLink(url?: string | null) {
  const s = String(url ?? '')
  const client = s.match(/app\.slack\.com\/client\/(T\w+)\/([CDG]\w+)/)
  if (client) return `slack://channel?team=${client[1]}&id=${client[2]}`
  const archives = s.match(/\/\/([\w-]+)\.slack\.com\/archives\/([CDG]\w+)/)
  const team = archives && (TEAMS[archives[1]] ?? process.env.PERCH_SLACK_TEAM_ID)
  return team ? `slack://channel?team=${team}&id=${archives![2]}` : null
}

export const dismissDraft = (id: string) => run(`update slack_drafts set status = 'dismissed', updated_at = ? where id = ?`, Date.now(), id)
export const editDraft = (id: string, text: string) => run(`update slack_drafts set text = ?, updated_at = ? where id = ? and status = 'draft'`, text, Date.now(), id)

// Fresh context: what's been said there since the agent looked.
export async function refreshContext(id: string) {
  const d = getDraft(id)
  if (!d) throw new Error('That draft is gone.')
  const tool = d.thread_ts ? 'slack_read_thread' : 'slack_read_channel'
  const args = d.thread_ts ? { channel_id: d.channel_id, message_ts: d.thread_ts, limit: 12, response_format: 'concise' } : { channel_id: d.channel_id, limit: 10, response_format: 'concise' }
  const out = await slackCall(tool, `Call ${tool} once with ${JSON.stringify(args)}. Reply with only JSON: {"messages": [{"author": "display name", "text": "the message, verbatim", "ts": "..."}]} oldest first.`)
  const r = json(out)
  if (!Array.isArray(r?.messages)) throw new Error('Couldn’t read the channel.')
  run('update slack_drafts set context = ?, updated_at = ? where id = ?', JSON.stringify(r.messages.slice(-12)), Date.now(), id)
  return getDraft(id)
}
