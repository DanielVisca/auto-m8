// Turning something dragged or pasted in from the browser into context the agent can use:
// a GitHub PR or issue becomes its live state and description; any other page, its title.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghExec } from './gh.ts'

const exec = promisify(execFile)
export type Enriched = { url: string; kind: 'pr' | 'issue' | 'page'; title: string; summary: string; context: string }

export async function enrich(url: string): Promise<Enriched> {
  const gh = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/)
  if (gh) {
    const [, owner, repo, kind, n] = gh
    if (kind === 'pull') {
      const { stdout } = await ghExec(['pr', 'view', n, '--repo', `${owner}/${repo}`, '--json', 'title,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,body,author'], { timeout: 15_000, maxBuffer: 5e6 })
      const p = JSON.parse(stdout)
      const failing = (p.statusCheckRollup ?? []).filter((c: any) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion ?? c.state)).map((c: any) => c.name ?? c.context)
      const running = (p.statusCheckRollup ?? []).some((c: any) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING')
      const checks = failing.length ? `${failing.length} failing (${failing.slice(0, 3).join(', ')})` : running ? 'running' : 'passing'
      const state = p.state === 'OPEN' ? (p.isDraft ? 'draft' : 'open') : p.state.toLowerCase()
      const summary = `${state}${p.state === 'OPEN' ? ` · checks ${checks}` : ''}${p.reviewDecision ? ` · ${p.reviewDecision.toLowerCase().replace('_', ' ')}` : ''} · +${p.additions}/-${p.deletions} in ${p.changedFiles} files`
      return { url, kind: 'pr', title: `${repo}#${n} ${p.title}`, summary,
        context: `PR ${owner}/${repo}#${n} by ${p.author?.login}: "${p.title}"\n${summary}\nBranch ${p.headRefName} → ${p.baseRefName}\n${String(p.body ?? '').slice(0, 1500)}` }
    }
    const { stdout } = await ghExec(['issue', 'view', n, '--repo', `${owner}/${repo}`, '--json', 'title,state,body,labels'], { timeout: 15_000, maxBuffer: 5e6 })
    const i = JSON.parse(stdout)
    return { url, kind: 'issue', title: `${repo}#${n} ${i.title}`, summary: i.state.toLowerCase(), context: `Issue ${owner}/${repo}#${n}: "${i.title}" (${i.state.toLowerCase()})\n${String(i.body ?? '').slice(0, 1500)}` }
  }
  const ctl = AbortSignal.timeout(6000)
  const html = await fetch(url, { signal: ctl, redirect: 'follow' }).then(r => r.text()).catch(() => '')
  const title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim().replace(/\s+/g, ' ') ?? new URL(url).hostname
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})/i)?.[1] ?? ''
  return { url, kind: 'page', title, summary: new URL(url).hostname, context: `Page "${title}" (${url})${desc ? `\n${desc}` : ''}` }
}
