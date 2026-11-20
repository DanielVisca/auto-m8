// Adds perch's GitHub-comment signing hook to ~/.claude/settings.json, so Claude sessions started
// outside perch must sign comments they post from your account too. Safe to run again.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const file = join(homedir(), '.claude/settings.json')
const hook = join(import.meta.dirname, '../server/signhook.ts')
const s = JSON.parse(readFileSync(file, 'utf8'))
const pre = ((s.hooks ??= {}).PreToolUse ??= [])
if (pre.some(m => m.hooks?.some(h => String(h.command).includes('signhook.ts')))) { console.log('already installed'); process.exit(0) }
copyFileSync(file, file + '.bak')
pre.push({ matcher: 'Bash|mcp__.*github.*|mcp__.*GitHub.*', hooks: [{ type: 'command', command: `'${process.execPath}' '${hook}'`, timeout: 10 }] })
writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
console.log('installed signing hook in', file, '(backup at settings.json.bak)')
