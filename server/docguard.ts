// "No agent text" mode, enforced: a PreToolUse hook (passed to every claude auto-m8 starts, next to
// signhook.ts) that refuses Write/Edit on a locked doc, and shell commands that write to one.
// Locked paths come from docs-locked.json, which docs.ts keeps current. Reading stays allowed.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const GUARD = join(process.env.PERCH_DATA ?? join(homedir(), 'Library/Application Support/perch'), 'docs-locked.json')
const WRITES = /(>>?|\btee\b|\bsed\s+-i|\bperl\s+-p?i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|writeFileSync|open\([^)]*['"]w)/

export const lockedDocs = (): string[] => { try { return existsSync(GUARD) ? JSON.parse(readFileSync(GUARD, 'utf8')) : [] } catch { return [] } }

export function check(input: any, locked: string[]): string | null {
  if (!locked.length) return null
  const tool = String(input?.tool_name ?? ''), args = input?.tool_input ?? {}
  const cwd = input?.cwd ?? process.cwd()
  const why = (p: string) => `${p} is in "no agent text" mode: the user writes every word of it. You may read it, comment and add research with the auto-m8 doc tool (action=comment / research), but not change its text. Put your suggestion in a comment instead.`
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const fp = args.file_path ?? args.notebook_path
    if (!fp) return null
    const abs = resolve(cwd, String(fp).replace(/^~(?=\/)/, homedir()))
    return locked.includes(abs) ? why(abs) : null
  }
  if (tool === 'Bash') {
    const cmd = String(args.command ?? '')
    if (!WRITES.test(cmd)) return null
    const hit = locked.find(p => cmd.includes(p) || cmd.includes(p.replace(homedir(), '~')))
    return hit ? why(hit) : null
  }
  return null
}

if (import.meta.main) {
  let raw = ''
  process.stdin.on('data', d => { raw += d })
  process.stdin.on('end', () => {
    let reason: string | null = null
    try { reason = check(JSON.parse(raw), lockedDocs()) } catch {}
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  })
}
