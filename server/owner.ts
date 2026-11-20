// Who perch works for, and what this Mac can take. Agents are told the owner's name (prompts,
// browser approvals, GitHub signatures), so nothing in perch is written for one person.
// Kept free of other perch imports: the signing hook runs it as a standalone process.
import { execFileSync } from 'node:child_process'
import { cpus, totalmem, userInfo } from 'node:os'

// First name from git (what the person already calls themselves in commits), else the login name.
export function detectName(): string {
  try {
    const full = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 3000 }).trim()
    if (full) return full.split(/\s+/)[0]
  } catch {}
  const u = userInfo().username
  return u ? u[0].toUpperCase() + u.slice(1) : 'the user'
}

let detected: string | undefined
// The server sets PERCH_OWNER_NAME from Settings (owner.name, blank = detect), and every claude,
// hook and MCP process it starts inherits it. Sessions outside perch fall back to detecting.
export function ownerName(env: NodeJS.ProcessEnv = process.env): string {
  return env.PERCH_OWNER_NAME?.trim() || (detected ??= detectName())
}
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`)

export const machine = { cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30) }
// Parallel helper checkouts this Mac can take: about one per 2.5 cores and 8 GB, between 2 and 6.
export const maxHelpers = Math.max(2, Math.min(6, Math.floor(Math.min(machine.cores / 2.5, machine.memGb / 8))))
export const machineLine = `${machine.cores} cores, ${machine.memGb} GB`
