// Reads Claude Code session transcripts (~/.claude/projects/<cwd-slug>/<session>.jsonl).
// PostHog Code writes the same format under its own config dir, so one parser covers both.
// Pure functions only: the indexer and the messages endpoint share them, and the test runs them.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { parseTaskNotification, type TaskDone } from '../shared/waits.ts'

export type Meta = {
  title: string | null // ai-title or custom-title; firstPrompt is the fallback
  firstPrompt: string | null
  cwd: string | null
  branch: string | null
  startedAt: number | null
  updatedAt: number | null
  messages: number
  text: string[] // user and assistant text for search, never tool output
  tools: { id: string; name: string; ts: number | null; detail?: string }[] // calls since the last flush
  errors: string[] // tool_use ids whose result was an error, since the last flush
  prs: Map<string, boolean> // url -> created by this conversation
  creating: Set<string> // tool_use ids whose call creates a PR
  listing: Set<string> // tool_use ids whose call lists PRs (open_prs, gh pr list): reading them doesn't link
  lastRole: 'user' | 'assistant' | null
  lastAssistant: string // tail of the last assistant text, to tell whether it ended on a question
  pending: Set<string> // tool calls with no result yet
  rootUuid: string | null // the first message's id: copies of a conversation (resumed, imported, branched) share it
  lastKind: 'text' | 'tool' | 'result' | 'error' | 'interrupt' | 'user' | null // what the transcript ends on
}

// The work stopped without finishing: the agent died mid-tool, never answered your last
// message, or ended on an API error. An interrupt you made yourself doesn't count.
export function stallOf(m: Pick<Meta, 'lastKind' | 'pending'>): string | null {
  if (m.lastKind === 'error') return 'ended on an API error'
  if (m.lastKind === 'tool' && m.pending.size) return 'stopped mid tool call (a permission prompt, or it died)'
  if (m.lastKind === 'result') return 'stopped after a tool result, before replying'
  if (m.lastKind === 'user') return 'never answered your last message'
  return null
}

// The agent ended its turn asking you something: a question mark at the end, or an offer.
export const asksUser = (m: Pick<Meta, 'lastRole' | 'lastAssistant'>) =>
  m.lastRole === 'assistant' && /\?\s*(\*\*)?\s*$|\b(want me to|should i|shall i|would you like|do you want|let me know|which (one|option) do you)\b/i.test(m.lastAssistant.slice(-400))

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const CREATES_PR = /gh pr create|create_pull_request|pull_request_create/

// A tool result naming many PRs is a listing (open_prs, shepherd status, gh pr list): reading it
// doesn't make the conversation about those PRs. Only a few PRs, or one it created, link.
// Listing tools by name; anything else naming more than 10 PRs is treated as a listing too. A PR
// view whose description names its stack still links that PR.
const LISTS_PRS = /open_prs|mcp__(?:auto-m8|auto_m8|perch)__shepherd|search_pull_requests|list_pull_requests|gh pr list|gh search prs|recent_activity/
export const LISTING = 10
function addPrs(meta: Meta, text: string, created: boolean, fromTool = false, listing = false) {
  const urls = [...new Set(text.match(PR_RE) ?? [])]
  if (fromTool && !created && (listing || urls.length > LISTING)) return
  for (const url of urls) meta.prs.set(url, created || meta.prs.get(url) === true)
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean; done?: TaskDone }

export type Activity = { tools: string[]; omitted?: number }

export type Item =
  | { kind: 'user'; text: string; ts?: number; uuid?: string; queued?: boolean } // queued: arrived mid-turn, delivered between steps
  | { kind: 'assistant'; blocks: Block[]; ts?: number; uuid?: string; mid?: string; model?: string; activity?: Activity }

export function emptyMeta(): Meta {
  return { title: null, firstPrompt: null, cwd: null, branch: null, startedAt: null, updatedAt: null, messages: 0, text: [], tools: [], errors: [], prs: new Map(), creating: new Set(), listing: new Set(), lastRole: null, lastAssistant: '', pending: new Set(), lastKind: null, rootUuid: null }
}

// Slash commands are stored as <command-name>/x</command-name><command-args>y</command-args>.
// Everything else wrapped in tags (stdout echoes, caveats, reminders) is harness noise.
export function userText(content: unknown): string | null {
  let text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
      : ''
  // Pasted or dropped images show as a marker in the thread; the image itself went to Claude.
  const imgs = Array.isArray(content) ? content.filter((b: any) => b?.type === 'image').length : 0
  if (imgs) text = `${text}\n\n🖼 ${imgs} image${imgs === 1 ? '' : 's'} attached`.trim()
  if (!text) return null
  const cmd = text.match(/<command-name>(.*?)<\/command-name>/s)
  if (cmd) {
    // A model switch (perch's routing, or yours) shows as a divider on the reply, not as a message.
    if (cmd[1].trim() === '/model') return null
    const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim()
    return args ? `${cmd[1].trim()} ${args}` : cmd[1].trim()
  }
  if (/^\s*<(local-command|command-message|system-reminder|bash-|task-notification)/.test(text)) return null
  if (text.startsWith('Caveat: ')) return null
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\n\n<perch-auto-race>[\s\S]*?<\/perch-auto-race>/g, '')
    // What perch added around your message: shown as short markers, not the machinery.
    .replace(/<attached-files>[\s\S]*?<\/attached-files>/g, m => (m.match(/^- .+\((.+)\)$/gm) ?? []).map(l => `📄 ${l.match(/\((.+)\)$/)![1]}`).join('\n'))
    .replace(/<shared-from-browser>[\s\S]*?<\/shared-from-browser>/g, m => (m.match(/https?:\/\/\S+/g) ?? []).map(u => `🔗 ${u}`).join('\n') || '🔗 shared some text from the browser')
    .replace(/<file path="([^"]*)"\s*\/>/g, (_m, p) => `[${p.split('/').pop()}]`)
    .replace(/<github_pr number="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/github_pr>)/g, 'PR #$1').trim()
  return text || null
}

const ts = (s: unknown) => (typeof s === 'string' ? Date.parse(s) || null : null)

// A title you can read at a glance: no pulled-in context blocks, harness tags, link markup
// or scout boilerplate. Links become what they point at (repo#123, host/path).
export function readableTitle(s: string): string {
  let t = String(s ?? '')
    .replace(/<earlier-conversations>[\s\S]*?(<\/earlier-conversations>|$)/g, ' ')
    .replace(/<(system-reminder|attached-files|attached-images|shared-from-browser|context|pasted_content)[^>]*>[\s\S]*?(<\/\1>|$)/g, ' ')
    // Attachment markers name the image, not the ask: "[Image: source: /tmp/…]", "🖼 2 images attached".
    .replace(/\[Image(?: #\d+)?(?::[^\]]*)?\]/g, ' ')
    .replace(/🖼 \d+ images? attached|\(see the attached (?:image|file|\d+ attachments)\)/g, ' ')
    .replace(/^\s*\[sandbox_prompt:[\w-]+:([\w.-]+)\][\s\S]*/, (_m, n) => `Scout: ${n}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2') // Slack <url|label>
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)\S*/g, '$1#$2')
    .replace(/https?:\/\/(?:www\.)?([^/\s]+)(\/[^\s?#]*)?\S*/g, (_m, h, path) => { const seg = String(path ?? '').split('/').filter(Boolean).pop(); return seg ? `${h}/…/${seg}` : h })
    .replace(/<\/?[a-z][\w-]*[^>]*>/gi, ' ')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t && /<attached-images>|\[Image/.test(String(s ?? ''))) return 'Image'
  if (!t && /<attached-files>/.test(String(s ?? ''))) return 'Attached file'
  return t || String(s ?? '').replace(/\s+/g, ' ').trim()
}

export function oneLine(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

// Folds one JSONL line into meta. Returns false for lines that aren't JSON.
export function applyLine(meta: Meta, line: string): boolean {
  let e: any
  try { e = JSON.parse(line) } catch { return false }
  if (e.type === 'perch-recovered-message' && e.entry) {
    // Historical recovery is searchable but must not make an old ask look unanswered now.
    const recovered = emptyMeta()
    applyLine(recovered, JSON.stringify(e.entry))
    meta.text.push(...recovered.text); meta.messages += recovered.messages
    if (recovered.updatedAt) meta.updatedAt = Math.max(meta.updatedAt ?? 0, recovered.updatedAt)
    return true
  }
  if (e.type === 'ai-title' && e.aiTitle) meta.title ??= e.aiTitle
  if (e.type === 'custom-title' && e.customTitle) meta.title = e.customTitle // a rename beats the generated title
  if (e.type === 'summary' && e.summary && !meta.title) meta.title = e.summary
  if (e.type === 'pr-link' && e.prUrl) meta.prs.set(e.prUrl, true)
  if (e.isSidechain) return true
  if ((e.type === 'user' || e.type === 'assistant') && e.uuid) meta.rootUuid ??= e.uuid
  const t = ts(e.timestamp)
  if (t) { meta.startedAt ??= t; meta.updatedAt = t }
  if (e.cwd) meta.cwd ??= e.cwd
  if (e.gitBranch) meta.branch = e.gitBranch
  if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
    const content = e.message.content
    if (Array.isArray(content)) for (const b of content) {
      if (b?.type !== 'tool_result') continue
      meta.pending.delete(b.tool_use_id)
      meta.lastKind = 'result'
      const created = meta.creating.has(b.tool_use_id)
      addPrs(meta, resultText(b.content), created, true, meta.listing.has(b.tool_use_id))
      if (b.is_error) meta.errors.push(b.tool_use_id)
    }
    const text = userText(content)
    const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b: any) => b?.text ?? '').join('') : ''
    if (/^\[Request interrupted/.test(raw)) meta.lastKind = 'interrupt'
    else if (text) meta.lastKind = 'user'
    if (text) {
      meta.lastRole = 'user'
      meta.messages++
      // A slash command makes a poor title; prefer the first real request.
      if (!meta.firstPrompt || (meta.firstPrompt.startsWith('/') && !text.startsWith('/'))) meta.firstPrompt = oneLine(readableTitle(text))
      meta.text.push(text)
      addPrs(meta, text, false)
    }
  } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    if (e.isApiErrorMessage) { meta.lastKind = 'error'; return true }
    for (const b of e.message.content) {
      if (b?.type === 'text' && b.text) meta.lastKind = 'text'
      if (b?.type === 'tool_use') { meta.pending.add(b.id); meta.lastKind = 'tool' }
      if (b?.type === 'text' && b.text) { meta.text.push(b.text); addPrs(meta, b.text, false); meta.lastRole = 'assistant'; meta.lastAssistant = b.text.slice(-600) }
      if (b?.type === 'tool_use') {
        // Which skill or subagent was used is worth counting; other inputs aren't stored.
        const detail = b.name === 'Skill' ? b.input?.skill : b.name === 'Agent' || b.name === 'Task' ? b.input?.subagent_type : undefined
        meta.tools.push({ id: b.id, name: b.name, ts: t, detail })
        if (CREATES_PR.test(b.name + ' ' + JSON.stringify(b.input ?? ''))) meta.creating.add(b.id)
        if (LISTS_PRS.test(b.name + ' ' + JSON.stringify(b.input ?? ''))) meta.listing.add(b.id)
      }
    }
  }
  return true
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n')
  return ''
}

// Older Perch Codex turns appended execution history to the answer as italic Markdown.
// Extract only Perch's own trailing footer; never rewrite the stored transcript or quoted examples.
function codexFooter(text: string): { text: string; activity?: Activity } {
  const footer = /\n\n_\(Codex ran: ([\s\S]+)\)_\s*$/.exec(text)
  if (!footer) return { text }
  const more = /; and (\d+) more$/.exec(footer[1])
  const history = more ? footer[1].slice(0, more.index) : footer[1]
  // A shell command can itself contain semicolons: split at known entry prefixes only.
  const tools = history.split(/; (?=\$ |[\w-]+\.[\w-]+(?: \(failed\))?(?:; |$)|edited |web search: )/)
  return { text: text.slice(0, footer.index), activity: { tools, ...(more ? { omitted: Number(more[1]) } : {}) } }
}

// The conversation as the chat view shows it. Tool results attach to their tool block.
// A parser that can be fed a transcript in pieces: transcripts only grow, so a reader that keeps
// the parser (itemsOf) parses each line once instead of the whole file on every read.
export class ItemsParser {
  private items: Item[] = []
  private tools = new Map<string, Extract<Block, { type: 'tool' }>>()
  private codexAnswers = new Map<string, Extract<Item, { kind: 'assistant' }>>()
  private last: Extract<Item, { kind: 'assistant' }> | null = null
  private lastMsgId: string | null = null
  private recovered = false
  feed(jsonl: string) {
    for (const line of jsonl.split('\n')) {
      if (!line) continue
      let e: any
      try { e = JSON.parse(line) } catch { continue }
      if (e.type === 'perch-recovered-message' && e.entry) { e = e.entry; this.recovered = true }
      if (e.isSidechain) continue
      if (e.type === 'perch-codex-activity') {
        const answer = this.codexAnswers.get(e.perchTurnId)
        if (answer && Array.isArray(e.tools)) answer.activity = { tools: e.tools.filter((t: unknown): t is string => typeof t === 'string') }
        continue
      }
      // A message that arrived mid-turn: Claude Code holds it until the running step ends, then
      // hands it over inside the same turn and saves it as an attachment, not a user line.
      if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
        const text = userText(e.attachment.prompt) // background-task notices etc. return null
        if (text) { this.items.push({ kind: 'user', text, ts: ts(e.timestamp) ?? undefined, uuid: e.uuid, queued: true }); this.last = null }
        continue
      }
      if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
        const content = e.message.content
        if (Array.isArray(content)) for (const b of content) {
          if (b?.type === 'tool_result') {
            const tool = this.tools.get(b.tool_use_id)
            if (tool) { tool.result = resultText(b.content); tool.isError = !!b.is_error }
          }
        }
        // A background agent, command or workflow finished: mark the call that started it.
        const note = parseTaskNotification(typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '')
        if (note) { const tool = this.tools.get(note.toolUseId); if (tool) tool.done = { status: note.status, summary: note.summary, at: ts(e.timestamp) ?? undefined } }
        const text = userText(content)
        if (text) { this.items.push({ kind: 'user', text, ts: ts(e.timestamp) ?? undefined, uuid: e.uuid }); this.last = null }
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        // One API message is stored as several lines (one per content block) sharing message.id.
        if (!this.last || e.message.id !== this.lastMsgId) {
          this.last = { kind: 'assistant', blocks: [], ts: ts(e.timestamp) ?? undefined, mid: typeof e.message.id === 'string' ? e.message.id : undefined, model: typeof e.message.model === 'string' && e.message.model !== '<synthetic>' ? e.message.model : undefined }
          this.items.push(this.last)
          this.lastMsgId = e.message.id
        }
        if (e.perchTurnId) this.codexAnswers.set(e.perchTurnId, this.last)
        this.last.uuid = e.uuid // the last line of the answer: branching after it keeps the whole answer
        if (Array.isArray(e.perchActivity?.tools)) {
          this.last.activity = { tools: e.perchActivity.tools.filter((t: unknown): t is string => typeof t === 'string') }
        }
        for (const b of e.message.content) {
          if (b?.type === 'text' && b.text) {
            const parsed = e.version === 'perch-codex' && !e.perchActivity ? codexFooter(b.text) : { text: b.text }
            if (parsed.text) this.last.blocks.push({ type: 'text', text: parsed.text })
            if ('activity' in parsed && parsed.activity) this.last.activity = parsed.activity
          }
          else if (b?.type === 'thinking' && b.thinking) this.last.blocks.push({ type: 'thinking', text: b.thinking })
          else if (b?.type === 'tool_use') {
            const tool = { type: 'tool' as const, id: b.id, name: b.name, input: b.input }
            this.tools.set(b.id, tool)
            this.last.blocks.push(tool)
          }
        }
      }
    }
  }
  // A new array each time; the items in it are shared with later reads, so don't change them.
  result(): Item[] {
    const visible = this.items.filter(i => i.kind === 'user' || i.blocks.length || i.activity?.tools.length)
    return this.recovered ? visible.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)) : visible
  }
}
export function toItems(jsonl: string): Item[] {
  const p = new ItemsParser()
  p.feed(jsonl)
  return p.result()
}

// A transcript file's items, parsed once and kept: each call reads only the bytes appended since
// the last one. Every chat open, attention sweep, promise scan and brief used to read and parse
// the whole file (the largest are 20-50 MB), on the event loop, which froze the server for seconds at a time.
// Kept for the transcripts in use, up to ITEMS_CACHE_BYTES of source text, least recently read out first.
const ITEMS_CACHE_BYTES = 160 << 20
type Kept = { parser: ItemsParser; offset: number; ino: number; guard: Buffer; used: number }
const kept = new Map<string, Kept>()
export const itemsCache = { hits: 0, grows: 0, full: 0 }
export function itemsOf(path: string): Item[] {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    let k = kept.get(path)
    if (k && (k.ino !== st.ino || st.size < k.offset || !sameTail(fd, k))) k = undefined // replaced, truncated or rewritten: start over
    if (!k) { k = { parser: new ItemsParser(), offset: 0, ino: st.ino, guard: Buffer.alloc(0), used: 0 }; itemsCache.full++ }
    else if (st.size > k.offset) itemsCache.grows++
    else itemsCache.hits++
    kept.delete(path); kept.set(path, k) // most recently used last
    if (st.size > k.offset) {
      const buf = Buffer.allocUnsafe(st.size - k.offset)
      let n = 0
      while (n < buf.length) { const r = readSync(fd, buf, n, buf.length - n, k.offset + n); if (!r) break; n += r }
      let end = buf.subarray(0, n).lastIndexOf(0x0a) + 1 // whole lines only; a half-written one is read next time
      // A last line with no newline yet counts when it is complete JSON (half a line never parses).
      if (end < n) try { JSON.parse(buf.toString('utf8', end, n)); end = n } catch {}
      if (end) {
        k.parser.feed(buf.toString('utf8', 0, end))
        k.offset += end
        k.guard = Buffer.from(buf.subarray(Math.max(0, end - 64), end))
      }
    }
    k.used = Date.now()
    let total = 0
    for (const v of kept.values()) total += v.offset
    for (const [p, v] of kept) { if (total <= ITEMS_CACHE_BYTES || p === path) break; kept.delete(p); total -= v.offset }
    return k.parser.result()
  } finally { closeSync(fd) }
}
// The bytes just before where we stopped are still what we read: the file was appended to, not rewritten.
function sameTail(fd: number, k: Kept) {
  if (!k.guard.length) return true
  const b = Buffer.alloc(k.guard.length)
  try { readSync(fd, b, 0, b.length, k.offset - b.length) } catch { return false }
  return b.equals(k.guard)
}
