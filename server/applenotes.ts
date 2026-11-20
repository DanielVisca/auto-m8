// Apple Notes, read-only. The Notes database is protected by macOS, so this needs Full Disk
// Access for the node that runs perch. Without it, everything here reports "needs access"
// instead of failing. Note bodies are stored gzipped as protobuf; the text lives at
// Document(2) → Note(3) → text(2). The database is copied before reading so Notes is never locked.
import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HOME } from './settings.ts'

const DIR = join(HOME, 'Library/Group Containers/group.com.apple.notes')
const DB = join(DIR, 'NoteStore.sqlite')
const APPLE_EPOCH = 978307200_000 // Core Data dates count seconds from 2001-01-01

export type AppleNote = { id: string; title: string; snippet: string; folder: string | null; modified: number; text: string }
export const notesStatus: { access: 'unknown' | 'granted' | 'needs-access' | 'missing'; count: number; lastRead: number; error?: string } = { access: 'unknown', count: 0, lastRead: 0 }
let cache: AppleNote[] = []

export function checkAccess() {
  if (!existsSync(DB)) return (notesStatus.access = 'missing')
  try { closeSync(openSync(DB, 'r')); return (notesStatus.access = 'granted') } catch { return (notesStatus.access = 'needs-access') }
}

// Minimal protobuf reader: enough to walk length-delimited fields.
function fields(buf: Buffer) {
  const out: { no: number; type: number; val: Buffer | number }[] = []
  let i = 0
  const varint = () => { let r = 0, s = 0, b; do { b = buf[i++]; r += (b & 0x7f) * 2 ** s; s += 7 } while (b & 0x80 && i < buf.length); return r }
  while (i < buf.length) {
    const key = varint(), no = Math.floor(key / 8), type = key & 7
    if (type === 0) out.push({ no, type, val: varint() })
    else if (type === 2) { const len = varint(); out.push({ no, type, val: buf.subarray(i, i + len) }); i += len }
    else if (type === 1) i += 8
    else if (type === 5) i += 4
    else break
  }
  return out
}
const field = (buf: Buffer, no: number) => fields(buf).find(f => f.no === no && f.type === 2)?.val as Buffer | undefined

export function noteText(zdata: Uint8Array): string {
  try {
    const raw = gunzipSync(Buffer.from(zdata))
    const doc = field(raw, 2), note = doc && field(doc, 3), text = note && field(note, 2)
    return text ? text.toString('utf8') : ''
  } catch { return '' }
}

export function readNotes(): AppleNote[] {
  if (checkAccess() !== 'granted') return []
  const tmp = mkdtempSync(join(tmpdir(), 'perch-notes-'))
  try {
    for (const f of ['NoteStore.sqlite', 'NoteStore.sqlite-wal', 'NoteStore.sqlite-shm']) if (existsSync(join(DIR, f))) copyFileSync(join(DIR, f), join(tmp, f))
    const db = new DatabaseSync(join(tmp, 'NoteStore.sqlite'), { readOnly: true })
    const cols = new Set((db.prepare(`pragma table_info(ZICCLOUDSYNCINGOBJECT)`).all() as any[]).map(c => c.name))
    const pick = (...names: string[]) => names.find(n => cols.has(n))
    const title = pick('ZTITLE1', 'ZTITLE'), mod = pick('ZMODIFICATIONDATE1', 'ZMODIFICATIONDATE'), folderTitle = pick('ZTITLE2', 'ZTITLE')
    const rows = db.prepare(`
      select n.ZIDENTIFIER id, n.${title} title, n.ZSNIPPET snippet, n.${mod} modified, f.${folderTitle} folder, d.ZDATA data
      from ZICCLOUDSYNCINGOBJECT n
      join ZICNOTEDATA d on d.ZNOTE = n.Z_PK
      left join ZICCLOUDSYNCINGOBJECT f on f.Z_PK = n.ZFOLDER
      where n.${title} is not null and coalesce(n.ZMARKEDFORDELETION, 0) = 0
      order by n.${mod} desc limit 2000`).all() as any[]
    db.close()
    cache = rows.map(r => ({ id: r.id, title: r.title, snippet: r.snippet ?? '', folder: r.folder ?? null, modified: APPLE_EPOCH + Number(r.modified ?? 0) * 1000, text: r.data ? noteText(r.data) : '' }))
    Object.assign(notesStatus, { count: cache.length, lastRead: Date.now(), error: undefined })
    return cache
  } catch (e: any) {
    notesStatus.error = String(e.message).slice(0, 200)
    return cache
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

export function appleNotes() {
  if (!cache.length || Date.now() - notesStatus.lastRead > 5 * 60_000) readNotes()
  return cache
}

export function searchAppleNotes(q: string, limit = 10) {
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  if (!words.length) return []
  return appleNotes()
    .map(n => ({ n, score: words.reduce((s, w) => s + (n.title.toLowerCase().includes(w) ? 3 : 0) + (n.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter(x => x.score >= words.length).sort((a, b) => b.score - a.score || b.n.modified - a.n.modified).slice(0, limit).map(x => x.n)
}

export const noteUrl = (id: string) => `applenotes:note/${id}`
