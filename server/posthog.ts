// PostHog extras over the REST API with your personal key: the skill store and scouts.
import { profile } from './profile.ts'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { posthogKey } from './keychain.ts'
import { ensureUser, posthogFetch, posthogStatus } from './indexer.ts'
import { childEnv, ephemeral } from './chat.ts'
import { all } from './db.ts'
import { chatSubject, originPrompt } from './origin.ts'
import { indexCloudTask } from './originsync.ts'
import { HOME, settings } from './settings.ts'

const exec = promisify(execFile)
const p = () => `/api/projects/${settings.posthog.projectId}`

// The whole catalogue, cached for ten minutes, so filtering and sorting are instant.
let catalog: { at: number; items: any[] } | null = null
async function allSkills() {
  if (catalog && Date.now() - catalog.at < 600_000) return catalog.items
  const items: any[] = []
  let url: string | null = `${p()}/llm_skills/?limit=100`
  for (let i = 0; url && i < 20; i++) {
    const page: any = await posthogFetch(url)
    items.push(...(page.results ?? []))
    url = page.next ? new URL(page.next).pathname + new URL(page.next).search : null
  }
  catalog = { at: Date.now(), items }
  return items
}

const DAY = 86400_000
// How often you used each skill (the Skill tool in your transcripts), in a time window.
const myUsage = (days: number) => new Map(all<{ detail: string; n: number }>(
  `select detail, count(*) n from tool_calls where name = 'Skill' and detail is not null and ts > ? group by detail`, days ? Date.now() - days * DAY : 0,
).map(r => [r.detail.replace(/^.*:/, ''), r.n]))

// "Mine" means you created it; "co-owned" means someone else did and you are an owner.
const created = (s: any, me: number) => s.created_by?.id === me || s.created_by_id === me
const owned = (s: any, me: number) => (s.owners ?? []).some((o: any) => o?.id === me || o === me)
const isMine = (s: any, me: number) => created(s, me) || owned(s, me)

export const skills = {
  cached: () => !!catalog,
  warm: () => allSkills().catch(() => {}),
  // sort: new | updated | top (your usage in the window) | name; mine: created or owned by you
  async list(opts: { q?: string; sort?: string; mine?: boolean | 'created' | 'owned'; days?: number; names?: string[] }) {
    const everything = await allSkills()
    let items = everything
    const usage = myUsage(opts.days ?? 0)
    if (opts.mine) { const me = await ensureUser(); items = items.filter(s => opts.mine === 'owned' ? isMine(s, me.id) : created(s, me.id)) }
    if (opts.names) {
      const order = new Map(opts.names.map((n, i) => [n, i]))
      items = items.filter(s => order.has(s.name)).sort((a, b) => order.get(a.name)! - order.get(b.name)!)
    } else if (opts.q) {
      const words = opts.q.toLowerCase().split(/\s+/).filter(Boolean)
      const hay = (s: any) => `${s.name} ${s.description ?? ''} ${s.category ?? ''}`.toLowerCase()
      items = items.map(s => ({ s, n: words.filter(w => hay(s).includes(w)).length + (s.name.includes(words.join('-')) ? 2 : 0) }))
        .filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => x.s)
    }
    // "Top (mine)" is a list of the skills you used in the window, not the whole store reordered.
    if (opts.sort === 'top' && !opts.names) items = items.filter(s => (usage.get(s.name) ?? 0) > 0)
    const time = (s: any, k: string) => Date.parse(s[k] ?? s.created_at ?? 0) || 0
    if (!opts.names && !(opts.q && opts.sort === 'relevance')) {
      const sorts: Record<string, (a: any, b: any) => number> = {
        new: (a, b) => time(b, 'created_at') - time(a, 'created_at'),
        updated: (a, b) => time(b, 'updated_at') - time(a, 'updated_at'),
        top: (a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0) || time(b, 'updated_at') - time(a, 'updated_at'),
        name: (a, b) => a.name.localeCompare(b.name),
      }
      items = [...items].sort(sorts[opts.sort ?? 'new'] ?? sorts.new)
    }
    const me = posthogStatus.user?.id
    return { results: items.map(s => ({ ...s, my_uses: usage.get(s.name) ?? 0, mine: me ? created(s, me) : false, coowned: me ? !created(s, me) && owned(s, me) : false })), total: everything.length }
  },
  // Claude reads the catalogue and picks what fits a request in plain words.
  async ask(question: string) {
    const items = await allSkills()
    const lines = items.map(s => `${s.name}: ${(s.description ?? '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')
    const prompt = `Pick the skills from this catalogue that best fit the request. Reply with ONLY a JSON array of up to 12 objects {"name": "...", "why": "short reason"}, best first. Use exact names.\n\nRequest: ${question}\n\nCatalogue:\n${lines}`
    const text = await new Promise<string>(resolve => {
      let out = ''
      ephemeral(['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', settings.ai.model, '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk'], settings.chat.cwd, ev => {
        if (ev.type === 'result') out = String(ev.result ?? '')
        if (ev.type === 'perch_done') resolve(out)
      })
    })
    const picks: { name: string; why: string }[] = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1) || '[]')
    const why = Object.fromEntries(picks.map(x => [x.name, x.why]))
    const { results } = await skills.list({ names: picks.map(x => x.name) })
    return { results: results.map(s => ({ ...s, why: why[s.name] })) }
  },
  get: (name: string, offset?: number) => posthogFetch(`${p()}/llm_skills/name/${encodeURIComponent(name)}/${offset != null ? `?body_offset=${offset}` : ''}`),
  // Installs one skill into ~/.claude/skills/<name>. PostHog's zip export refuses personal API
  // keys, so the skill is rebuilt from what the key can read: the body (paged) and each file.
  async install(name: string, root = join(profile.claudeDir, 'skills')) {
    const base = `${p()}/llm_skills/name/${encodeURIComponent(name)}/`
    const first: any = await posthogFetch(base)
    let body: string = first.body ?? ''
    for (let off = first.body_next_offset; off != null && body.length < 2e6;) {
      const page: any = await posthogFetch(`${base}?body_offset=${off}`)
      body += page.body ?? ''
      off = page.body_next_offset
    }
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const front = ['---', `name: ${name}`, `description: ${JSON.stringify(first.description ?? '')}`,
      ...(first.allowed_tools?.length ? [`allowed-tools: ${JSON.stringify(first.allowed_tools)}`] : []),
      ...(first.license ? [`license: ${JSON.stringify(first.license)}`] : []), '---', ''].join('\n')
    writeFileSync(join(dir, 'SKILL.md'), front + body)
    let files = 0
    for (const f of first.files ?? []) {
      const safe = String(f.path).replace(/^\/+/, '')
      if (safe.includes('..')) continue
      const got: any = await posthogFetch(`${base}files/${safe.split('/').map(encodeURIComponent).join('/')}/`)
      mkdirSync(dirname(join(dir, safe)), { recursive: true })
      writeFileSync(join(dir, safe), got.content ?? '')
      files++
    }
    return { installed: dir, files, message: `Installed ${name} for Claude Code (${files + 1} files). New sessions can use it.` }
  },
  // The whole store as a Claude Code plugin marketplace: mint the access command, then run it.
  async installStore() {
    let r: any
    try { r = await posthogFetch(`${p()}/llm_skills/marketplace/install-command/`, { method: 'POST', body: JSON.stringify({ rotate: false }) }) }
    catch (e: any) {
      if (/personal API key|403/.test(String(e.message))) return { ok: false, message: 'PostHog only gives out the store token in its web app.', action: 'In PostHog → Skills, choose “Install in Claude Code”, copy the command, and paste it here. Mothership runs it for you.', needsPaste: true }
      throw e
    }
    if (!r.command) return { ok: false, message: 'PostHog didn’t return an install command.', action: 'Try again in a minute, or paste the command from PostHog → Skills.', needsPaste: true }
    return runStoreCommand(r.command)
  },
  installCommand: () => posthogFetch(`${p()}/llm_skills/marketplace/install-command/`),
}

export const scouts = {
  async list(opts: { q?: string; mine?: boolean; sort?: string } = {}) {
    const page: any = await posthogFetch(`${p()}/signals/scout/configs/?limit=200`)
    let items: any[] = page.results ?? (Array.isArray(page) ? page : [])
    if (opts.mine) { const me = await ensureUser(); items = items.filter(s => isMine(s, me.id)) }
    if (opts.q) {
      const words = opts.q.toLowerCase().split(/\s+/).filter(Boolean)
      items = items.filter(s => { const hay = JSON.stringify([s.display_name, s.skill_name, s.description, s.tags]).toLowerCase(); return words.every(w => hay.includes(w)) })
    }
    const t = (s: any, k: string) => Date.parse(s[k] ?? 0) || 0
    if (opts.sort === 'new') items.sort((a, b) => t(b, 'created_at') - t(a, 'created_at'))
    else if (opts.sort === 'name') items.sort((a, b) => String(a.display_name ?? a.skill_name ?? '').localeCompare(String(b.display_name ?? b.skill_name ?? '')))
    else items.sort((a, b) => t(b, 'last_run_at') - t(a, 'last_run_at') || t(b, 'updated_at') - t(a, 'updated_at'))
    return { results: items.slice(0, 200).map(s => ({ ...s, mine: posthogStatus.user ? isMine(s, posthogStatus.user.id) : false })), total: page.count ?? items.length }
  },
  // Each run with where to open it: perch when it knows the task, else PostHog (absolute URL).
  async runs(configId?: string) {
    const r: any = await posthogFetch(`${p()}/signals/scout/runs/${configId ? `?config=${encodeURIComponent(configId)}` : ''}`)
    const list: any[] = Array.isArray(r) ? r : r.results ?? []
    return list.map(x => ({ ...x,
      posthog_url: x.task_url ? new URL(x.task_url, settings.posthog.host).toString() : x.task_id ? `${settings.posthog.host}${p().replace('/api/projects', '/project')}/tasks/${x.task_id}` : null,
      perch_id: x.task_id && all<any>('select 1 from conversations where id = ?', `task:${x.task_id}`).length ? `task:${x.task_id}` : null }))
  },
  run: (id: string) => posthogFetch(`${p()}/signals/scout/configs/${encodeURIComponent(id)}/run/`, { method: 'POST', body: '{}' }),
  // Billed cost (USD) of each of your scouts' runs, keyed by task_run_id, for joining to what a run
  // reported (its structured output names a PR). Cached ten minutes.
  async billedRuns(days = 30): Promise<Map<string, number>> {
    const hit = billedCache.get(days)
    if (hit && Date.now() - hit.at < 600_000) return hit.data
    const since = new Date(Date.now() - days * DAY).toISOString()
    const skills = (await scouts.list({ mine: true })).results.map((s: any) => s.skill_name).filter(Boolean)
    const out = new Map<string, number>()
    const queue = [...new Set<string>(skills)]
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let skill; (skill = queue.shift());) {
        let before: string | undefined
        for (let page = 0; page < 30; page++) {
          const qs = new URLSearchParams({ skill_name: skill, date_from: since, limit: '100', ...(before ? { date_to: before } : {}) })
          const list = await posthogFetch(`${p()}/signals/scout/runs/?${qs}`).catch(() => []) as any[]
          for (const r of list) if (r.task_run_id && r.total_spend != null) out.set(r.task_run_id, r.total_spend / 100)
          if (list.length < 100) break
          before = list[list.length - 1].created_at
        }
      }
    }))
    billedCache.set(days, { at: Date.now(), data: out })
    return out
  },
  // What each scout cost over the last `days`, summed from its runs' total_spend (USD cents,
  // partial while a run is in progress). The runs list caps at 100, so walk back with date_to.
  async spend(skillNames: string[], days = 7) {
    const since = new Date(Date.now() - days * DAY).toISOString()
    const one = async (skill: string) => {
      const hit = spendCache.get(`${skill}:${days}`)
      if (hit && Date.now() - hit.at < 600_000) return hit.data
      let cents = 0, runs = 0, untracked = 0, before: string | undefined
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ skill_name: skill, date_from: since, limit: '100', ...(before ? { date_to: before } : {}) })
        const list = await posthogFetch(`${p()}/signals/scout/runs/?${qs}`) as any[]
        for (const r of list) { runs++; if (r.total_spend == null) untracked++; else cents += r.total_spend }
        if (list.length < 100) break
        before = list[list.length - 1].created_at
      }
      const data = { usd: Math.round(cents) / 100, runs, untracked }
      spendCache.set(`${skill}:${days}`, { at: Date.now(), data })
      return data
    }
    const out: Record<string, { usd: number; runs: number; untracked: number }> = {}
    const queue = [...new Set(skillNames.filter(Boolean))]
    await Promise.all(Array.from({ length: 4 }, async () => { for (let s; (s = queue.shift());) out[s] = await one(s).catch(() => ({ usd: 0, runs: 0, untracked: -1 })) }))
    return { days, by_skill: out, total_usd: Math.round(Object.values(out).reduce((a, x) => a + x.usd, 0) * 100) / 100 }
  },
}
const billedCache = new Map<number, { at: number; data: Map<string, number> }>()
const spendCache = new Map<string, { at: number; data: { usd: number; runs: number; untracked: number } }>()

// PostHog cloud tasks: the same agents behind @PostHog in Slack and PostHog Code's cloud runs.
// Any perch agent (Claude or Codex) can start one, follow it, and talk to it while it runs.
export const tasks = {
  create: (title: string, description: string, repository?: string) =>
    posthogFetch(`${p()}/tasks/`, { method: 'POST', body: JSON.stringify({ title, description, repository, origin_product: 'user_created' }) }),
  models: () => posthogFetch(`${p()}/tasks/models/`),
  // Create the task and start its first run in the cloud sandbox.
  start: async (o: { title?: string; description: string; repository?: string; branch?: string; model?: string; reasoning_effort?: string; parent?: string }) => {
    const description = [o.description, o.parent ? originPrompt(o.parent) : ''].filter(Boolean).join('\n\n')
    const t: any = await posthogFetch(`${p()}/tasks/`, { method: 'POST', body: JSON.stringify({ title: o.title ?? o.description.slice(0, 80), description, repository: o.repository, origin_product: 'user_created' }) })
    const me = await ensureUser()
    indexCloudTask(t, me.id, o.parent ? chatSubject(o.parent) : undefined)
    const run: any = await posthogFetch(`${p()}/tasks/${t.id}/run/`, { method: 'POST', body: JSON.stringify({ mode: 'background', branch: o.branch, model: o.model, reasoning_effort: o.model ? o.reasoning_effort : undefined }) })
    return run
  },
  get: (id: string) => posthogFetch(`${p()}/tasks/${id}/`),
  // Tell a running task something (steer it), as you would in the PostHog Code composer.
  message: (id: string, runId: string, content: string) =>
    posthogFetch(`${p()}/tasks/${id}/runs/${runId}/command/`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'user_message', params: { content } }) }),
  // The run's raw session log (notifications: turn_complete, session/prompt, agent messages, …).
  rawLogs: async (id: string, runId: string) => { const rows: any = await posthogFetch(`${p()}/tasks/${id}/runs/${runId}/session_logs/`); return (Array.isArray(rows) ? rows : rows.results ?? []) as any[] },
  // The run's session log, condensed to what the agent said and which tools it called.
  logs: async (id: string, runId: string, max = 12000) => {
    const rows: any = await posthogFetch(`${p()}/tasks/${id}/runs/${runId}/session_logs/`)
    const lines: string[] = [], list: any[] = Array.isArray(rows) ? rows : rows.results ?? []
    // Runs log both streamed chunks and the whole message; take whole messages when there are any.
    const whole = list.some(r => ((r.notification ?? r)?.params?.update ?? (r.notification ?? r)?.update)?.sessionUpdate === 'agent_message')
    for (const r of list) {
      const n = r.notification ?? r, u = n?.params?.update ?? n?.update
      if (u?.sessionUpdate === (whole ? 'agent_message' : 'agent_message_chunk') && u.content?.text) lines.push(u.content.text + (whole ? '\n' : ''))
      else if (u?.sessionUpdate === 'tool_call') lines.push(`\n[tool ${u.title ?? u.kind ?? ''}]\n`)
    }
    const text = lines.join('').replace(/\n{3,}/g, '\n\n')
    return text.length > max ? '…' + text.slice(-max) : text
  },
}

// Runs PostHog's "/plugin marketplace add … / /plugin install …" lines through the Claude Code CLI.
export async function runStoreCommand(text: string) {
  const add = text.match(/marketplace add\s+"?([^\s"]+)"?/)?.[1]
  const plugin = text.match(/plugin install\s+([^\s]+)/)?.[1]
  if (!add || !plugin) return { ok: false, message: 'That doesn’t look like the install command from PostHog.', action: 'Copy the whole command from PostHog → Skills → Install in Claude Code.' }
  const env = childEnv()
  await exec('claude', ['plugin', 'marketplace', 'add', add], { timeout: 120_000, env }).catch(e => { if (!/already/i.test(String(e.stderr ?? e.message))) throw e })
  await exec('claude', ['plugin', 'install', plugin], { timeout: 120_000, env })
  return { ok: true, message: 'The PostHog skill store is installed in Claude Code. New sessions see every skill in it.' }
}

// The PostHog MCP registry (ranked by liveness and real usage): which server would provide a capability.
const discoverCache = new Map<string, { at: number; data: any }>()
export async function discoverMcp(intent: string, limit = 5) {
  const key = `${intent.toLowerCase()}:${limit}`
  const hit = discoverCache.get(key)
  if (hit && Date.now() - hit.at < 86400_000) return hit.data
  const data = await posthogFetch(`${p()}/mcp_registry/servers/discover/?intent=${encodeURIComponent(intent)}&limit=${limit}`)
  discoverCache.set(key, { at: Date.now(), data })
  return data
}
