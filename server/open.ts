// "Open in…": jump to the app a conversation lives in, at the right spot. Runs on the Mac, so
// only requests from the Mac itself may use it (a phone uses the https links instead).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { get } from './db.ts'
import { settings } from './settings.ts'

const exec = promisify(execFile)
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export type Target = 'terminal' | 'cursor' | 'finder' | 'posthog-code' | 'slack' | 'posthog'

// Which places a conversation can be opened in, with the link where there is one.
export function targets(id: string) {
  const c = get<any>('select id, source, cwd, url, slack_url from conversations where id = ?', id)
  if (!c) return []
  const out: { target: Target; label: string; href?: string }[] = []
  if (c.slack_url) out.push({ target: 'slack', label: 'Slack thread', href: c.slack_url })
  if (c.url) out.push({ target: 'posthog', label: 'PostHog', href: c.url })
  if (c.source === 'posthog-code') out.push({ target: 'posthog-code', label: 'PostHog Code' })
  if (c.source !== 'posthog-task') out.push({ target: 'terminal', label: 'Terminal (claude --resume)' })
  if (c.cwd && existsSync(c.cwd)) out.push({ target: 'cursor', label: 'Cursor' }, { target: 'finder', label: 'Finder' })
  return out
}

// Opens a file at a line in Cursor (or VS Code), the way citations in search answers link to it.
export async function openFile(path: string, line?: number) {
  const cursor = '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'
  const target = line ? `${path}:${line}` : path
  if (existsSync(cursor)) return exec(cursor, ['-g', target])
  if (existsSync('/usr/local/bin/code')) return exec('/usr/local/bin/code', ['-g', target])
  return exec('open', [path])
}

export async function openIn(id: string, target: Target) {
  const c = get<any>('select id, source, cwd, url, slack_url from conversations where id = ?', id)
  if (!c) throw new Error('unknown conversation')
  const cwd = c.cwd && existsSync(c.cwd) ? c.cwd : settings.chat.cwd
  switch (target) {
    case 'slack': return exec('open', [c.slack_url]) // the Slack app takes its own https links
    case 'posthog': return exec('open', [c.url])
    case 'posthog-code': return exec('open', ['-a', 'PostHog']) // no deep link to a session exists yet
    case 'cursor': return exec('open', ['-a', 'Cursor', cwd])
    case 'finder': return exec('open', [cwd])
    case 'terminal': {
      const configDir = settings.sources.find(s => s.id === c.source)?.configDir
      const env = configDir && !configDir.endsWith('/.claude') ? `CLAUDE_CONFIG_DIR=${sh(configDir)} ` : ''
      const cmd = `cd ${sh(cwd)} && ${env}claude --resume ${c.id}`
      return exec('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, '-e', 'tell application "Terminal" to activate'])
    }
  }
}
