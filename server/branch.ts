// Branches and restore points. A conversation is an append-only transcript, so branching is
// cheap and never destructive: copy the transcript up to a message into a new session id and
// resume that. "Rewind" is a branch that becomes the one you work in; the original is kept.
// Code follows along: at the start of every turn in a perch chat the working tree is
// snapshotted as a git commit under refs/perch/ (no branch, no checkout, no stash entry), so a
// branch can also put the files back the way they were at that point.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { link } from './context.ts'
import { inheritChat, chatSubject } from './origin.ts'
import { setStates, setTitle } from './conversations.ts'
import { all, get, run } from './db.ts'

const exec = promisify(execFile)
// Restore points are perch's own bookkeeping, not your commits: never signed (your 1Password
// signing would otherwise wait for approval on every turn).
const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => exec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 20e6, timeout: 30_000 }).then(r => r.stdout.trim())

// The working tree at this moment, tracked and untracked (respecting .gitignore), as a commit.
export async function snapshot(conversationId: string, cwd: string) {
  if (!cwd || !existsSync(join(cwd, '.git')) && !(await git(cwd, ['rev-parse', '--git-dir']).catch(() => ''))) return null
  const turn = Number(get<any>('select count(*) n from snapshots where conversation_id = ?', conversationId)?.n ?? 0)
  const dir = mkdtempSync(join(tmpdir(), 'perch-snap-'))
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
    // Start from a copy of the repo's own index, not 'read-tree HEAD': a fresh index has no stat
    // cache, so 'add -A' re-hashed every tracked file (tens of thousands in a posthog worktree) at
    // the start of every turn of every chat. The copy gives the same tree in a fraction of the time.
    const own = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).catch(() => '')
    let copied = false
    if (own && existsSync(own)) try { copyFileSync(own, env.GIT_INDEX_FILE); copied = true } catch {}
    if (head && !copied) await git(cwd, ['read-tree', 'HEAD'], env)
    await git(cwd, ['add', '-A'], env)
    const tree = await git(cwd, ['write-tree'], env)
    const sha = await git(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `perch restore point ${conversationId} turn ${turn}`])
    await git(cwd, ['update-ref', `refs/perch/${conversationId}/${turn}`, sha])
    run('insert or replace into snapshots (conversation_id, turn, sha, cwd, created_at) values (?, ?, ?, ?, ?)', conversationId, turn, sha, cwd, Date.now())
    return sha
  } catch { return null } finally { rmSync(dir, { recursive: true, force: true }) }
}

export const snapshotsFor = (id: string) => all<any>('select turn, sha, cwd, created_at from snapshots where conversation_id = ? order by turn', id)

// Copies the transcript up to and including the line with `uuid` into a new session.
export function fork(id: string, uuid: string | null) {
  const c = get<any>('select path, cwd, title, first_prompt, source from conversations where id = ?', id)
  if (!c?.path || !existsSync(c.path)) throw new Error('This conversation has no local transcript to branch from.')
  const lines = readFileSync(c.path, 'utf8').split('\n').filter(Boolean)
  let end = lines.length
  if (uuid) {
    const i = lines.findIndex(l => l.includes(`"uuid":"${uuid}"`))
    if (i < 0) throw new Error('That message is no longer in the transcript.')
    // Keep the rest of that message (an answer is stored as several lines) up to the next prompt.
    end = i + 1
    while (end < lines.length) {
      const e = JSON.parse(lines[end])
      if (e.type === 'user' && !e.isMeta && typeof e.message?.content === 'string') break
      if (e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b.type === 'text')) break
      end++
    }
  }
  const newId = randomUUID()
  inheritChat(newId, chatSubject(id), 'conversation fork')
  const out = lines.slice(0, end).map(l => {
    try { const e = JSON.parse(l); if (e.sessionId) e.sessionId = newId; if (e.session_id) e.session_id = newId; return JSON.stringify(e) } catch { return l }
  }).filter(l => !l.includes('"type":"ai-title"') && !l.includes('"type":"custom-title"'))
  const shown = get<any>('select title from user_state where id = ?', id)?.title ?? c.title ?? c.first_prompt ?? 'Conversation'
  const title = `${String(shown).replace(/ \(branch\)$/, '').slice(0, 100)} (branch)`
  out.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newId }))
  writeFileSync(join(dirname(c.path), `${newId}.jsonl`), out.join('\n') + '\n')
  link(newId, id, 'branch', uuid ? 'branched from a message' : 'branched at the end')
  setTitle(newId, title)
  // The turn this branch starts from: how many prompts the copy contains.
  const turn = out.filter(l => { try { const e = JSON.parse(l); return e.type === 'user' && !e.isMeta && (typeof e.message?.content === 'string' || e.message?.content?.some?.((b: any) => b.type === 'text')) } catch { return false } }).length
  return { id: newId, turn, cwd: c.cwd as string | null, source: c.source }
}

// Puts the files back to how they were at a turn. The current state is snapshotted first, so
// even this can be undone. Files created after that point are left alone.
export async function restoreFiles(id: string, turn: number) {
  const snap = get<any>('select * from snapshots where conversation_id = ? and turn <= ? order by turn desc limit 1', id, turn)
  if (!snap) throw new Error('There is no restore point for that moment (only chats run in perch have them).')
  const undo = await snapshot(`${id}-before-restore`, snap.cwd)
  await git(snap.cwd, ['restore', `--source=${snap.sha}`, '--worktree', '--', '.'])
  return { restored: snap.sha.slice(0, 8), undo: undo?.slice(0, 8), cwd: snap.cwd }
}

// Rewind = branch at a message and make the branch current; the original moves to Later.
export async function rewind(id: string, uuid: string, files: boolean) {
  const b = fork(id, uuid)
  let restored = null
  if (files) restored = await restoreFiles(id, Math.max(0, b.turn - 1)).catch(e => ({ error: e.message }))
  setStates([id], { state: 'later' })
  link(b.id, id, 'rewound', 'rewound from here')
  return { ...b, restored }
}

void basename
