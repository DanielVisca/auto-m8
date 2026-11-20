// A Slack message an agent drafted for you: what was said there recently, the draft (editable),
// and you decide: send it, open it as a draft in Slack, or drop it. Agents can't send to Slack.
import { useEffect, useState } from 'react'
import { post, toast, useLive } from './api'
import { Brand } from './Brand'

type Draft = { id: string; channel_id: string; channel_name: string | null; thread_ts: string | null; text: string; why: string | null
  context: { author: string; text: string; ts?: string }[]; permalink: string | null; status: string; sent_link: string | null; error: string | null; created_at: number
  file?: string | null; reply_to?: string | null }

const when = (ts?: string) => ts && /^\d+(\.\d+)?$/.test(ts) ? new Date(Number(ts) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export function SlackDraftCard({ id }: { id: string }) {
  const { data: d, reload } = useLive<Draft>(`/api/slack/drafts/${id}`, ['conversations'])
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  useEffect(() => { if (d && text === null) setText(d.text) }, [d]) // eslint-disable-line
  if (!d || (d as any).error === 'That draft is gone.') return null
  const where = `#${d.channel_name ?? d.channel_id}${d.thread_ts || d.reply_to ? ' · thread' : ''}`
  const fileName = d.file?.split('/').pop()
  const raw = d.file ? `/api/files/raw?path=${encodeURIComponent(d.file)}` : ''
  const act = async (what: 'send' | 'open' | 'dismiss' | 'refresh') => {
    setBusy(what)
    try {
      if (what === 'dismiss') { await post(`/api/slack/drafts/${id}/dismiss`); reload(); return }
      if (what === 'refresh') { await post(`/api/slack/drafts/${id}/refresh`); reload(); return }
      const r = await post<any>(`/api/slack/drafts/${id}/${what}`, { text })
      if (r.error) return
      if (what === 'send') toast(`Sent to ${where}.`, { kind: 'ok' })
      if (what === 'open' && r.link) window.open(r.link, '_blank')
      reload()
    } finally { setBusy('') }
  }
  const done = d.status === 'sent' || d.status === 'dismissed'
  return (
    <div className={`slack-draft ${d.status}`}>
      <div className="sd-head">
        <Brand id="slack" size={14} />
        <b>{where}</b>
        <span className="muted small grow">{d.status === 'sent' ? 'sent' : d.status === 'in-slack' ? 'in your Slack drafts' : d.status === 'dismissed' ? 'dropped' : 'draft for you to send'}</span>
        {d.permalink && <a className="small" href={d.permalink} target="_blank" rel="noreferrer">open in Slack ↗</a>}
      </div>
      {d.why && <div className="small muted sd-why">{d.why}</div>}
      {d.reply_to && !d.thread_ts && <div className="small muted sd-why">↳ Replies in the thread of the other draft once that one is sent.</div>}
      {d.file && <div className="sd-file">
        {/\.(mp4|m4v|mov|webm)$/i.test(d.file) ? <video src={raw} controls preload="metadata" playsInline />
          : /\.(png|jpe?g|gif|webp)$/i.test(d.file) ? <img src={raw} alt={fileName} /> : null}
        <div className="small muted">📎 {fileName} {done ? '' : 'is attached: it goes up with the message'}</div>
      </div>}
      {d.context.length > 0 && !done && (
        <div className="sd-context">
          {d.context.map((m, i) => <div key={i} className="sd-msg"><b>{m.author}</b> <span className="muted small">{when(m.ts)}</span><div>{m.text}</div></div>)}
          <button className="link small" disabled={!!busy} onClick={() => act('refresh')}>{busy === 'refresh' ? 'reading Slack…' : '↻ latest'}</button>
        </div>
      )}
      {done
        ? <div className="sd-sent">{d.text}{d.sent_link && <div><a className="small" href={d.sent_link} target="_blank" rel="noreferrer">view in Slack ↗</a></div>}</div>
        : <>
            <textarea className="sd-text" value={text ?? ''} rows={Math.min(10, Math.max(3, (text ?? '').split('\n').length + 1))}
              onChange={e => setText(e.target.value)} onBlur={() => text !== null && text !== d.text && post(`/api/slack/drafts/${id}/edit`, { text })} />
            {d.error && <div className="bad small">{d.error}</div>}
            <div className="sd-actions">
              <button className="primary" disabled={!!busy || !text?.trim()} onClick={() => act('send')}>{busy === 'send' ? 'Sending…' : 'Send'}</button>
              <button disabled={!!busy || !text?.trim()} onClick={() => act('open')} title={d.file ? 'Puts the text in your Slack drafts (without the file: Slack drafts can\'t hold one)' : 'Puts it in your Slack drafts for that channel and opens Slack there'}>{busy === 'open' ? 'Opening…' : 'Open draft in Slack'}</button>
              <button className="link small" disabled={!!busy} onClick={() => act('dismiss')}>drop</button>
            </div>
          </>}
    </div>
  )
}

// A Slack link you shared into the chat, shown as a card instead of a bare URL.
const SLACK_LINK = /^https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(\S*))?$/
export const isSlackLink = (u: string) => SLACK_LINK.test(u)
export function SlackLinkCard({ url }: { url: string }) {
  const m = url.match(SLACK_LINK)
  if (!m) return null
  const ts = `${m[2]}.${m[3]}`
  const threadTs = new URLSearchParams(m[4] ?? '').get('thread_ts')
  const host = new URL(url).hostname.split('.')[0]
  return (
    <a className="slack-link" href={url} target="_blank" rel="noreferrer" title={url}>
      <Brand id="slack" size={22} />
      <span className="sl-body">
        <b>Slack {threadTs ? 'thread' : 'message'}</b>
        <span className="muted small">{host} · {m[1]} · {when(ts)}</span>
      </span>
      <span className="sl-open small">Open ↗</span>
    </a>
  )
}
