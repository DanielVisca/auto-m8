// What a background task wrote, for the drill-down in a chat's "Waiting" card: the tail of a
// command's or monitor's .output log, an agent's transcript as readable steps, or each agent
// a workflow ran. Only reads Claude Code's own task files, never an arbitrary path.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const MAX = 96 * 1024
const PROJECTS = join(homedir(), '.claude', 'projects')

export type Step = { kind: 'text' | 'tool' | 'result' | 'prompt'; text: string; at?: string }
export type TaskOutput =
  | { kind: 'log'; path: string; text: string; truncated: boolean; size: number; updatedAt: number; exitCode?: number }
  | { kind: 'transcript'; path: string; steps: Step[]; truncated: boolean; updatedAt: number; finished?: boolean }
  | { kind: 'workflow'; path: string; agents: { id: string; description: string; finished: boolean; last: string; updatedAt: number }[] }
  | { kind: 'missing'; path: string; reason: string }

function allowed(p: string): string | null {
  let real: string
  try { real = realpathSync(p) } catch { return null }
  const inClaudeTmp = /^\/(private\/)?tmp\/claude-\d+\//.test(real)
  let projects = PROJECTS
  try { projects = realpathSync(PROJECTS) } catch {}
  return inClaudeTmp || real.startsWith(projects + '/') ? real : null
}

function tailBytes(p: string, size: number): { text: string; truncated: boolean } {
  if (size <= MAX) return { text: readFileSync(p, 'utf8'), truncated: false }
  const fd = openSync(p, 'r'), buf = Buffer.alloc(MAX)
  try { readSync(fd, buf, 0, MAX, size - MAX) } finally { closeSync(fd) }
  const s = buf.toString('utf8')
  return { text: s.slice(s.indexOf('\n') + 1), truncated: true }
}

const one = (v: unknown) => typeof v === 'string' ? v : ''
const short = (s: string, n = 600) => s.length > n ? s.slice(0, n) + '…' : s

// Readable steps from a Claude Code JSONL transcript: what the agent said and each tool it ran.
export function stepsOf(jsonl: string): Step[] {
  const out: Step[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const content = o.message?.content
    if (o.type === 'user') {
      if (typeof content === 'string') { if (!out.length) out.push({ kind: 'prompt', text: short(content, 2000), at: o.timestamp }); continue }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result') {
          const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => one(c.text)).join('\n') : ''
          if (t.trim()) out.push({ kind: 'result', text: short(t.trim(), 400), at: o.timestamp })
        } else if (b.type === 'text' && !out.length) out.push({ kind: 'prompt', text: short(one(b.text), 2000), at: o.timestamp })
      }
    } else if (o.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && one(b.text).trim()) out.push({ kind: 'text', text: b.text.trim(), at: o.timestamp })
        else if (b.type === 'tool_use') {
          const i = b.input ?? {}
          const what = one(i.description) || one(i.command) || one(i.file_path) || one(i.pattern) || one(i.query) || one(i.prompt) || one(i.url)
          out.push({ kind: 'tool', text: `${b.name}${what ? ': ' + short(what.replace(/\s+/g, ' '), 200) : ''}`, at: o.timestamp })
        }
      }
    }
  }
  return out
}

const looksJsonl = (s: string) => /^\s*\{"/.test(s)

// An agent's output_file can be gone (tmp cleaned); its transcript also lives in the session's subagents dir.
function agentFallback(p: string): string | null {
  const m = p.match(/\/tmp\/claude-\d+\/([^/]+)\/([^/]+)\/tasks\/([^/.]+)\.output$/)
  if (!m) return null
  const alt = join(PROJECTS, m[1], m[2], 'subagents', `agent-${m[3]}.jsonl`)
  return existsSync(alt) ? alt : null
}

export function taskOutput(path: string): TaskOutput {
  if (!path) return { kind: 'missing', path, reason: 'This task didn’t say where its output goes.' }
  const real = allowed(path) ?? (() => { const alt = agentFallback(path); return alt && allowed(alt) })()
  if (!real) return { kind: 'missing', path, reason: existsSync(path) ? 'Not a Claude Code task file.' : 'The output file is gone (temp files are cleared once the session that ran it ends).' }
  const st = statSync(real)
  if (st.isDirectory()) {
    const agents = readdirSync(real).filter(f => /^agent-.*\.jsonl$/.test(f)).map(f => {
      const file = join(real, f), id = basename(f, '.jsonl').replace(/^agent-/, '')
      let meta: any = {}
      try { meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch {}
      const s = statSync(file)
      const steps = stepsOf(tailBytes(file, s.size).text)
      const last = [...steps].reverse().find(x => x.kind === 'text')?.text ?? [...steps].reverse()[0]?.text ?? ''
      return { id, description: one(meta.description) || id, finished: !!meta.finished, last: short(last, 800), updatedAt: s.mtimeMs }
    }).sort((a, b) => a.updatedAt - b.updatedAt)
    return { kind: 'workflow', path: real, agents }
  }
  const { text, truncated } = tailBytes(real, st.size)
  if (real.endsWith('.jsonl') || looksJsonl(text)) {
    let meta: any = {}
    try { meta = JSON.parse(readFileSync(real.replace(/\.(jsonl|output)$/, '.meta.json'), 'utf8')) } catch {}
    return { kind: 'transcript', path: real, steps: stepsOf(text).slice(-200), truncated, updatedAt: st.mtimeMs, finished: meta.finished }
  }
  // Claude Code ends a finished command's log with this line, even when its notification never reached the chat.
  const exit = text.match(/\[exited with code (-?\d+)\]\s*$/)
  return { kind: 'log', path: real, text, truncated, size: st.size, updatedAt: st.mtimeMs, exitCode: exit ? Number(exit[1]) : undefined }
}
