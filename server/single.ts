// One perch server per data folder. Imported first by main.ts, before any module opens the db,
// reattaches chats or starts shepherds: a second server (the shell's health loop respawning one
// that was still starting up, or `npm run dev` next to the app) used to run all of that and only
// then die on EADDRINUSE, 17 times on 2026-11-12. Now it sees the live owner's pid and leaves.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const isPerchServer = (pid: number) => {
  try { process.kill(pid, 0) } catch { return false }
  try { return /server\/main\.ts/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })) } catch { return true }
}

// Take the lock or name the pid that holds it. Exclusive create, so two starting at the same
// moment can't both win; a lock left by a dead (or reused, non-perch) pid is taken over.
export function claimServerLock(file: string, pid = process.pid, alive: (pid: number) => boolean = isPerchServer): { ok: true } | { ok: false, owner: number } {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx')
      writeSync(fd, String(pid)); closeSync(fd)
      return { ok: true }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: true } // can't lock (read-only dir): don't block startup
      const owner = Number(readFileSync(file, 'utf8').trim())
      if (owner > 0 && owner !== pid && alive(owner)) return { ok: false, owner }
      try { unlinkSync(file) } catch {}
    }
  }
  return { ok: true }
}

export function releaseServerLock(file: string, pid = process.pid) {
  try { if (Number(readFileSync(file, 'utf8').trim()) === pid) unlinkSync(file) } catch {}
}

if (!process.env.NODE_TEST_CONTEXT && !process.env.PERCH_DB?.startsWith(':memory:') && process.env.PERCH_NO_LOCK !== '1') {
  const dir = process.env.PERCH_DATA ?? join(homedir(), 'Library/Application Support/perch')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'server.pid')
  const got = claimServerLock(file)
  if (!got.ok) {
    console.error(`Mothership: server ${got.owner} already serves ${dir}; not starting a second one`)
    process.exit(3) // the shell reads 3 as "already served": no restart, no crash back-off
  }
  // main.ts's signal handlers record the stop and call process.exit, which runs this.
  process.on('exit', () => releaseServerLock(file))
}
