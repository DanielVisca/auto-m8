// Things you paste or drop into a chat: images, files, and long text saved as a file so the
// prompt stays readable. Stored under the data dir; chats get --add-dir on it so Claude can Read them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './settings.ts'

export const ATTACH_DIR = join(DATA_DIR, 'attachments')
mkdirSync(ATTACH_DIR, { recursive: true })
const MAX = 30 * 1024 * 1024

export function saveAttachment(b: { name?: string; base64?: string; text?: string }) {
  const buf = b.text != null ? Buffer.from(String(b.text), 'utf8') : Buffer.from(String(b.base64 ?? ''), 'base64')
  if (!buf.length) throw new Error('That file is empty.')
  if (buf.length > MAX) throw new Error('That file is over 30 MB. Put it in the project folder and mention its path instead.')
  const dir = join(ATTACH_DIR, new Date().toISOString().slice(0, 10))
  mkdirSync(dir, { recursive: true })
  const name = String(b.name || 'pasted.txt').replace(/[^\w.@-]+/g, '_').slice(-80)
  const path = join(dir, `${randomUUID().slice(0, 8)}-${name}`)
  writeFileSync(path, buf)
  return { path, bytes: buf.length, lines: b.text != null ? String(b.text).split('\n').length : null }
}

export type Attachment = { path: string; name: string; kind: 'image' | 'file'; media_type?: string; bytes?: number; lines?: number | null }

// Images go to Claude as image blocks; everything else is named by path for it to Read.
export function attachmentParts(list: Attachment[]) {
  const safe = list.filter(a => a.path?.startsWith(ATTACH_DIR))
  const isImage = (a: Attachment) => a.kind === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(a.media_type ?? '')
  const images = safe.filter(isImage).slice(0, 20).map(a => ({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: readFileSync(a.path).toString('base64') } }))
  // Anything else (PDFs, logs, code, other image formats) is read from disk by path.
  const files = safe.filter(a => !isImage(a))
  // Image paths too, so the thread can show a preview and Claude can reopen them later.
  const imgNote = safe.filter(isImage).length ? `<attached-images>\n${safe.filter(isImage).slice(0, 20).map(a => `- ${a.path}`).join('\n')}\n</attached-images>` : ''
  const fileNote = files.length ? `<attached-files>\nThe user attached these files. Read them with the Read tool before answering.\n${files.map(f => `- ${f.path} (${f.name}${f.lines ? `, ${f.lines} lines` : f.bytes ? `, ${Math.round(f.bytes / 1024)} KB` : ''})`).join('\n')}\n</attached-files>` : ''
  return { images, note: [imgNote, fileNote].filter(Boolean).join('\n') }
}
