// FTS5 indexes words, not our unindexed conversation id, so looking a document up by id scans every
// document and reads every body (15MB over 2,134 chats in Nov 2026). persist did that on every chat
// append, inside the write transaction: a 19s freeze got the live server killed on 2026-11-16.
// search_rowids maps id -> FTS rowid so the lookup is an index hit. An id missing from the map
// (a new conversation, or a row written some other way) falls back to the scan once.
import { all, db, once, run } from './db.ts'

db.exec('create table if not exists search_rowids (id text primary key, rowid integer not null)')
// Existing documents: keep the newest row per id (older duplicates are stale) and map it. One scan.
once('search-rowids-v1', () => {
  run('delete from search where rowid not in (select max(rowid) from search group by id)')
  run('insert or replace into search_rowids (id, rowid) select id, max(rowid) from search group by id')
})

type Update = { id: string; title: string; body: string | ((old: string) => string) }
type Entry = { rowid: number; id: string; title: string; body: string }

// Call inside the transaction that saves the conversation. Leave unchanged documents alone, and
// replace changed ones by FTS rowid.
export function updateSearch(updates: Update[]) {
  if (!updates.length) return
  const ids = [...new Set(updates.map(u => u.id))]
  const marks = ids.map(() => '?').join(',')
  const previous = new Map<string, Entry[]>()
  const add = (row: Entry) => { const rows = previous.get(row.id) ?? []; if (!rows.some(r => r.rowid === row.rowid)) rows.push(row); previous.set(row.id, rows) }
  for (const row of all<Entry>(`select s.rowid, m.id, s.title, s.body from search_rowids m join search s on s.rowid = m.rowid where m.id in (${marks})`, ...ids)) add(row)
  const unmapped = ids.filter(id => !previous.has(id))
  if (unmapped.length) for (const row of all<Entry>(`select rowid, id, title, body from search where id in (${unmapped.map(() => '?').join(',')})`, ...unmapped)) add(row)
  for (const u of updates) {
    const rows = previous.get(u.id) ?? []
    const body = typeof u.body === 'function' ? u.body(rows[0]?.body ?? '') : u.body
    if (rows.length === 1 && rows[0].title === u.title && rows[0].body === body) { if (unmapped.includes(u.id)) run('insert or replace into search_rowids (id, rowid) values (?, ?)', u.id, rows[0].rowid); continue }
    for (const row of rows) run('delete from search where rowid = ?', row.rowid)
    const { lastInsertRowid } = run('insert into search (id, title, body) values (?, ?, ?)', u.id, u.title, body)
    run('insert or replace into search_rowids (id, rowid) values (?, ?)', u.id, Number(lastInsertRowid))
    previous.set(u.id, [{ rowid: Number(lastInsertRowid), id: u.id, title: u.title, body }])
  }
}
