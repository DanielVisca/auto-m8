// Live capability profile per runtime (which agent, and where it runs), so a job goes where it can
// actually work: not to a cloud run when it needs the Mac (local files, Tailscale, the signed-in
// Agent Chrome, a personal GitHub repo), and not to an agent whose MCP server is down.
// Facts that change are probed and cached; facts that are structural are written down here once.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { codexBin, codexReadySync } from './codex.ts'
import { claudeOut as claudeIsOut } from './account.ts'
import { mcpRows } from './mcpaccess.ts'

const exec = promisify(execFile)
const out = (bin: string, args: string[], timeout = 8000) => exec(bin, args, { timeout, env: process.env }).then(r => r.stdout, e => String(e?.stdout ?? ''))

export type RuntimeId = 'claude-local' | 'codex-local' | 'local-model' | 'cloud-task'
export type Needs = {
  localFiles?: boolean // uncommitted or unpushed work, files outside a repo
  tailscale?: boolean // Grafana, Argo CD, kubectl, anything on the tailnet
  browserProfile?: boolean // the signed-in Agent Chrome
  perchTools?: boolean // delegate, canvas, shepherd, needs_me, ...
  repoOwner?: string // GitHub owner of the repo the job touches
  mcp?: string[] // MCP servers the job needs
}
export type Profile = {
  id: RuntimeId; label: string; where: 'mac' | 'cloud'
  ready: boolean; why?: string // live: can it take a job right now
  can: { localFiles: boolean; tailscale: boolean; browserProfile: boolean; perchTools: boolean }
  github: { accounts: string[]; owners: string[] | 'any-local-account' } // who it can push as
  mcp: Record<string, string> // server -> state, for the agents that have MCP
  strengths: string[]; limits: string[]
}

// Orgs the PostHog cloud task runner has the GitHub app on. A personal repo is not one of them.
const CLOUD_OWNERS = ['PostHog']

let probes: { at: number; v: Promise<{ gh: string[]; tailnet: boolean; ollama: boolean; mcp: { claude: Record<string, string>; codex: Record<string, string> } }> } | null = null
const probe = () => {
  if (!probes || Date.now() - probes.at > 90_000) probes = { at: Date.now(), v: (async () => {
    const [gh, ts, oll, rows] = await Promise.all([
      out('gh', ['auth', 'status']),
      out('tailscale', ['status', '--json'], 4000),
      fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false),
      mcpRows().catch(() => ({ claude: [], codex: [] })),
    ])
    let tailnet = false
    try { tailnet = JSON.parse(ts).BackendState === 'Running' } catch {}
    const map = (r: { server: string; state: string }[]) => Object.fromEntries(r.map(x => [x.server, x.state]))
    return { gh: [...gh.matchAll(/Logged in to \S+ account (\S+)/g)].map(m => m[1]), tailnet, ollama: oll, mcp: { claude: map(rows.claude), codex: map(rows.codex) } }
  })() }
  return probes.v
}

export async function profiles(): Promise<Profile[]> {
  const p = await probe()
  const claudeOut = claudeIsOut()
  const local = { localFiles: true, tailscale: p.tailnet, browserProfile: true, perchTools: true }
  return [
    { id: 'claude-local', label: 'Claude on the Mac', where: 'mac', ready: !claudeOut, why: claudeOut ? 'Claude is at its limit' : undefined,
      can: local, github: { accounts: p.gh, owners: 'any-local-account' }, mcp: p.mcp.claude,
      strengths: ['claude.ai connectors (Docs, Slack once authorised)', 'everything on this Mac'], limits: [] },
    { id: 'codex-local', label: 'Codex on the Mac', where: 'mac', ready: !!codexBin() && codexReadySync(), why: !codexBin() ? 'codex is not installed' : codexReadySync() ? undefined : 'Codex is capped or logged out',
      can: local, github: { accounts: p.gh, owners: 'any-local-account' }, mcp: p.mcp.codex,
      strengths: ['independent second opinion', 'its own plan limit when Claude is capped'], limits: ['no claude.ai connectors'] },
    { id: 'local-model', label: 'Local model (Ollama)', where: 'mac', ready: p.ollama, why: p.ollama ? undefined : 'Ollama is not running',
      can: local, github: { accounts: p.gh, owners: 'any-local-account' }, mcp: p.mcp.claude,
      strengths: ['free, private, no cap'], limits: ['weak on long multi-file changes', 'smaller context'] },
    { id: 'cloud-task', label: 'PostHog cloud task', where: 'cloud', ready: true,
      can: { localFiles: false, tailscale: false, browserProfile: false, perchTools: false }, github: { accounts: ['PostHog cloud runner'], owners: CLOUD_OWNERS }, mcp: {},
      strengths: ['runs while the Mac is closed or busy', 'parallel, no local load'], limits: ['only repos the PostHog GitHub app can reach', 'no Tailscale (Grafana, Argo CD, kubectl)', 'no signed-in browser', 'no perch tools or local files; unpushed work must be on a branch'] },
  ]
}

// What a piece of work needs, read from its text and where it lives. Over-asks rather than under-asks:
// a false "needs the Mac" costs a bit of load, a false "cloud is fine" fails the job.
export function needsFrom(text: string, o: { repoOwner?: string; dirty?: boolean; cwd?: string } = {}, serverNames: string[] = []): Needs {
  const t = text.toLowerCase()
  const n: Needs = {}
  if (o.dirty || /(^|\s)(~\/|\/users\/)/i.test(text)) n.localFiles = true
  if (/grafana|argo ?cd|kargo|kubectl|\beks\b|tailscale|tailnet|victoriametrics|vmagent/.test(t)) n.tailscale = true
  if (/signed.?in|agent chrome|perch browser|browser tool|logged.?in session/.test(t)) n.browserProfile = true
  if (/\b(delegate|shepherd|needs_me|canvas|perch tool|follow_up)\b/.test(t)) n.perchTools = true
  if (o.repoOwner) n.repoOwner = o.repoOwner
  const norm = (s: string) => s.toLowerCase().replace(/^(claude\.ai |plugin:)/, '').replace(/[^a-z0-9]/g, '')
  const mcp = serverNames.filter(s => s.length > 3 && norm(s) && t.replace(/[^a-z0-9 ]/g, '').includes(norm(s)))
  if (mcp.length) n.mcp = mcp
  return n
}

export type Verdict = { id: RuntimeId; label: string; ok: boolean; blockers: string[] }
export function check(profs: Profile[], needs: Needs): Verdict[] {
  const norm = (s: string) => s.toLowerCase().replace(/^(claude\.ai |plugin:)/, '').replace(/[^a-z0-9]/g, '')
  return profs.map(p => {
    const b: string[] = []
    if (!p.ready) b.push(p.why ?? 'not ready')
    if (needs.localFiles && !p.can.localFiles) b.push('needs local files or unpushed work')
    if (needs.tailscale && !p.can.tailscale) b.push('needs Tailscale (internal Grafana, Argo CD, kubectl)')
    if (needs.browserProfile && !p.can.browserProfile) b.push('needs the signed-in Agent Chrome')
    if (needs.perchTools && !p.can.perchTools) b.push('needs perch tools')
    if (needs.repoOwner && p.github.owners !== 'any-local-account' && !p.github.owners.some(o => o.toLowerCase() === needs.repoOwner!.toLowerCase())) b.push(`cannot push to ${needs.repoOwner} (only ${p.github.owners.join(', ')})`)
    if (needs.repoOwner && p.github.owners === 'any-local-account' && !p.github.accounts.length) b.push('no GitHub login')
    for (const s of needs.mcp ?? []) {
      const state = Object.entries(p.mcp).find(([k]) => norm(k) === norm(s))?.[1]
      if (!state) b.push(`no ${s} MCP server`)
      else if (/auth|fail/i.test(state)) b.push(`${s} MCP is ${state}`)
    }
    return { id: p.id, label: p.label, ok: !b.length, blockers: b }
  })
}

// Why a cloud hand-off should not happen right now, or null. Used by the cloud gate.
export async function cloudBlockers(needs: Needs): Promise<string[]> {
  const v = check(await profiles(), needs).find(x => x.id === 'cloud-task')
  return v?.blockers.filter(b => b !== 'not ready') ?? []
}

export async function describe(task?: string, hints: { repoOwner?: string; dirty?: boolean } = {}): Promise<string> {
  const profs = await profiles()
  const names = [...new Set(profs.flatMap(p => Object.keys(p.mcp)))]
  const lines = profs.map(p => `- ${p.label} [${p.where}] ${p.ready ? 'ready' : `NOT READY: ${p.why}`}
    can: ${Object.entries(p.can).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none of the local things'}; pushes as: ${p.github.owners === 'any-local-account' ? `any repo ${p.github.accounts.join('/') || 'a local login'} can reach` : p.github.owners.join(', ')}${Object.keys(p.mcp).length ? `; MCP: ${Object.entries(p.mcp).filter(([, s]) => /connected|enabled/.test(s)).map(([k]) => k).join(', ') || 'none working'}` : ''}
    good for: ${p.strengths.join('; ')}${p.limits.length ? `\n    limits: ${p.limits.join('; ')}` : ''}`)
  if (!task && !hints.repoOwner) return lines.join('\n')
  const needs = needsFrom(task ?? '', hints, names)
  const v = check(profs, needs)
  return `${lines.join('\n')}\n\nNeeds read from the task: ${JSON.stringify(needs)}\n${v.map(x => `- ${x.label}: ${x.ok ? 'can take it' : `no: ${x.blockers.join('; ')}`}`).join('\n')}\n(Needs are guessed from the text; correct them if you know better.)`
}
