// perch server: one local process that indexes, runs chats and terminals, and serves the UI.
// Bound to 127.0.0.1 and checks Origin/Host on every request, because it can run commands:
// without that, any web page could reach it through the browser.
import './single.ts' // first: one server per data folder, before anything opens the db or reattaches chats
import './path.ts' // then: find claude/gh even when started without ~/.zshrc's PATH
import { cancelLogin, login as claudeLogin, startLogin, submitCode } from './claudelogin.ts'
import { carrySkill, importSkill } from './skillcarry.ts'
import { allCapped, capsNow } from './router.ts'
import { carryText, carryTo, importCarry } from './carry.ts'
import { applyProfileEnv, profile, profiles, readiness, saveProfiles } from './profile.ts'
import { detectName as detectOwnerName } from './owner.ts'
import { homedir } from 'node:os'
import { localStatus, pull as pullModel } from './local.ts'
import { usageNow, claudeSubsNow } from './usage.ts'
import { overageNow } from './overage.ts'
import { addSub, billingStatus, clearCaps, loginOf, pickSub, refreshLogins, removeSub, shareFolder, subOf, subs, subUsage, updateSub } from './account.ts'
import { mcpAccess, resetMcpRows } from './mcpaccess.ts'
import { mcpLogins, onMcpLogin, startMcpLogin, submitMcpCode } from './mcplogin.ts'
import { cloudBlockers, describe as describeRuntimes, needsFrom } from './runtimes.ts'
import { codexDefaultModel, codexModels, codexReady } from './codex.ts'
import { syncAgents } from './agentsync.ts'
import { chatUsage, engineFor, setEngine, usageSummary } from './turns.ts'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { check as checkFile, conversationFiles, fileAction, fileRaw } from './files.ts'
import { dismissDraft, draftInSlack, draftsFor, editDraft, getDraft, refreshContext, sendDraft } from './slack.ts'
import { recentPage, sidebar } from './sidebar.ts'
import { evidence } from './evidence.ts'
import { journey, mergePlan, queue as queuePr } from './journey.ts'
import { prPage, prSidebar } from './prview.ts'
import { rateLast, setTurbo, turboFor, turnStats } from './turns.ts'
import { data as canvasData, makeTile, onCanvas, onCanvasData, removeTile, reportTile, saveTile, tiles as canvasTiles } from './canvas.ts'
import { dropPromise, nudge, onPromises, openPromises, promisesOf, scanForPromises, tickPromises } from './promises.ts'
import { attachmentParts, saveAttachment } from './attachments.ts'
import { onPrFlow, prFlow } from './prflow.ts'
import { answerDecision, autoDecided, decideDue, decisionsFor, onDecision, openDecisions } from './decisions.ts'
import { sweepNeeds } from './needs.ts'
import { need, needHistory, needsList, recheckNeed, reportNeed, updateNeed } from './needsstore.ts'
import { captureApproval } from './needssources.ts'
import { credits, recordAttention } from './needsattention.ts'
import { cleanListingLinks } from './db.ts'
import { projectStatus, projects } from './projects.ts'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer } from 'ws'
import { btw, chats, interrupt, onAuthLapse, noticeLive, noticesFor, onChatsChange, reattachChats, runningChats, send, sendInterceptors, setCloudFallback, subscribe } from './chat.ts'
import { contextBlock, link, links, related } from './context.ts'
import { planForPrompt } from './prroute.ts'
import { all, get, refreshMeta, run, writes } from './db.ts'
import { originChain, searchOrigins } from './origin.ts'
import { originSyncStatus } from './originsync.ts'
import { sweepTitles } from './titles.ts'
import { family } from './family.ts'
import { allLabels, applyRules, markSeen, setTitle, deleteRule, detail, editLabels, list, listRules, saveRule, setStates, siblings } from './conversations.ts'
import { ask, briefing, generateBrief, home, today } from './brief.ts'
import { indexStatus, onChange, onTick, posthogStatus, scanAll, startIndexer, syncMyPrs, syncPrs, syncTasks } from './indexer.ts'
import { clearAnthropicKey, clearPangramKey, clearPosthogKey, pangramKey, posthogKey, setAnthropicKey, setPangramKey, setPosthogKey } from './keychain.ts'
import { addComment, addResearch, agentEdit, deleteComment, deleteResearch, DOCS_DIR, getDoc, listDocs, newDoc, onDocs, openDoc, dictionaryWords, editDictionary, pangramBalance, pangramCheck, resolveComment, watchDoc, restoreVersion, saveDoc, snapshot, toSlack, updateDoc, version as docVersion, type Author as DocAuthor } from './docs.ts'
import { runStoreCommand, scouts, skills, tasks } from './posthog.ts'
import { onError, recentErrors, recordError, resolveErrors } from './errors.ts'
import { taskOutput } from './taskOutput.ts'
import { isPaused, overview as pauseOverview, pauseAll, resumeAll } from './pause.ts'
import { deleteRoutine, fire, listRoutines, saveRoutine, startScheduler } from './routines.ts'
import { DATA_DIR, settings, updateSettings } from './settings.ts'
import { clickhouseDisks, connectors as exploreConnectors, dataFor as exploreData, listRepos, prewarmRuntime, whereItRuns } from './explorer-runtime.ts'
import { summaryFor as exploreSummary, warmSummaries } from './explorer-summary.ts'
import { usageFor as exploreUsage } from './explorer-usage.ts'
import { setSwrDir, swr } from './swr.ts'
import { checkRepo, exploreDream, exploreGraph, exploreNode, exploreTimeline, openLocal as exploreOpen, saveDream, setDataDir as setExploreDir } from './explorer.ts'
import { cloneLayout, LAYOUT_DIR, listLayouts, listVersions as listLayoutVersions, loadLayout, readTile, restoreVersion as restoreLayoutVersion, sharedLayouts, snapshot as snapshotLayouts, watchLayouts, writeGuide } from './layout.ts'
import { refreshBasics, refreshMcp, status } from './status.ts'
import { closeTerm, createTerm, listTerms, onTermsChange, readTerm, runPending, sendTerm, termEvents, terms, typedInto, waitTerm } from './term.ts'
import { completePairing, deviceFor, isLoopback, lanHosts, listDevices, revokeDevice, setRemoteOnlyPort, startPairing, UNPAIRED_PAGE } from './remote.ts'
import { gitInfo, idleFromLogs, leaseFor, leases, makeCloud, RETURN_BY } from './cloud.ts'
import { beat, getDraft as getComposeDraft, handoff, macIdleMs, mobileStatus, notify, notifyTick, openProdAlerts, pushKey, putDraft, refreshTailscale, remotePort, setTailscale, stayAwakeTick, subscribe as pushSubscribe, tailscale, tailscaleUrl, unsubscribe as pushUnsubscribe } from './mobile.ts'
import { backfillStartedBy, focusSuggestions, onListChange } from './conversations.ts'
import { openFile, openIn, targets, type Target } from './open.ts'
import { enrich } from './enrich.ts'
import { checkSlowDeploys, listDeploys } from './deploys.ts'
import { addAgent, fixCi, orchestrate, prWorkers, deepAudit, preview as prPreview, pushThrough, snooze } from './pr.ts'
import { compare, judge, linkGroup } from './compare.ts'
import { fork, restoreFiles, rewind, snapshotsFor } from './branch.ts'
import { hookSignals } from './hookSignals.ts'
import { handleHookPost } from './hookRoute.ts'
import { dismiss as dismissAttention, sweep as attentionSweep } from './attention.ts'
import { resumeStalls } from './resumestalls.ts'
import { relay, relayGraph } from './relay.ts'
import { harvest as harvestChat, harvestOf, lifecycleStatus, sweepLifecycle } from './lifecycle.ts'
import { board, push as inboxPush, startOrchestra, stopTargets, unwatch as orchUnwatch, watch as orchWatch } from './orchestra.ts'
import { forParent as helpersOf, onDelegate, resumeFollowers as resumeHelpers, sendTo as helperSend, start as startHelper, stop as stopHelper } from './delegate.ts'
import { overview as gitOverview, repoGit, repos as gitRepos } from './gitexplorer.ts'
import { snapshotAge as worktreeSnapshotAge, describe as describeWorktrees, helperWorktreesRunning, inventory as worktreeInventory, lastSweep, LIMITS as WT_LIMITS, remove as removeWorktree, startSweeping as sweepWorktreesHourly, sweep as sweepWorktrees } from './worktrees.ts'
import { listRuns, onOptimize, pause as pauseOpt, resume as resumeOpt, resumeFollowers, runFor, start as startOpt, stop as stopOpt } from './optimize.ts'
import { discoverMcp } from './posthog.ts'
import { appleNotes, checkAccess, noteUrl, notesStatus, readNotes } from './applenotes.ts'
import { localSkills, quick, SOURCES } from './search.ts'
import { deleteFolder, folder, folders, onFolders, organize, organizerStatus, saveFolder, startOrganizer } from './folders.ts'
import { summarizePrs, addTactic, evaluatePlaybook, feedback as searchFeedback, history as searchHistory, learn as learnSearch, maybeLearn, searchStats, startSearch, steer as steerSearch } from './seek.ts'
import { dryRun as dryRunSuggestion, later as laterSuggestion, undo as undoSuggestion } from './autopilot.ts'
import { accept as acceptSuggestion, dismiss as dismissSuggestion, onAutopilot, overview as autopilotOverview, review, scan as autopilotScan, startAutopilot } from './autopilot.ts'
import { toItems, itemsOf } from './transcript.ts'
import { ignoreNeed, needs as wishNeeds, startWishes, wishCycle } from './wishes.ts'
import { cycle as evolveCycle, forge, ignore as ignoreUseCase, onEvolve, overview as evolveOverview, restore as restoreSkill, retire as retireSkill, rollback as rollbackSkill, startEvolve } from './evolve.ts'
import { startShepherd } from './shepherd.ts'
import { localScoutSpend, scanTranscripts, spendSummary, startSpend } from './spend.ts'
import { prSpend, prSpendDetail } from './prspend.ts'
import { detail as raceDetail, insights as raceInsights, start as startRaceRun, startRace } from './race.ts'
import { skipCandidate } from './autorace.ts'
import { forPr as shadowForPr, overview as shadowOverview, pick as shadowPick, start as startShadowRun, startShadow } from './shadow.ts'
import { railyard, startRailyard } from './railyard.ts'
import { startProof } from './proof.ts'
import { report as learnReport, startLearn } from './learn.ts'
import { board as getBoard, boards as listBoards, openedBoard, chatBoard, copyTile, createBoard, deleteBoard, ensurePlanBoard, expireBoards, putTile, requireCanvas, showBoard, updateBoard, useBoard } from './boards.ts'
import { onPresence, presenceAll, presenceError, refreshPresence } from './presence.ts'
import { moveToSection, onPrSections, resortSections } from './prsections.ts'
import { approvals, browserEvents, closeIdleWindows, freezeIdleWindows, lowerChromePriority, onBrowserChange, pruneRecordings, resumeBrowser, setOwnerBusy } from './browser.ts'
import { browserRoutes, browserSocket } from './browserroutes.ts'
import { researchRoutes } from './productresearchroutes.ts'
import { canvases as exploreCanvases, codebases as exploreCodebases, competitor as exploreCompetitor, competitors as exploreCompetitors, saveThumb, thumbFile } from './explorehub.ts'
import { ensureProductBoard } from './productresearchboard.ts'
import { audiences as shareAudiences, forgetShare, shareBoard, shareStatus, sharesOf, targets as shareTargets } from './share.ts'
import { onResearch } from './productresearch.ts'
import { restartQueue } from './restartqueue.ts'
import { availability, noteBoot, noteOutage, noteStop, recordAvailability, writeReason } from './uptime.ts'
import { explainStall, startStallProfiler } from './stallprof.ts'
import { localResources } from './resources.ts'
import { endTrace, report as latencyReport, routeOf, runInTrace, startLatency, startTrace } from './latency.ts'
import { query as traceQuery, recordClient, startTraceStore } from './tracestore.ts'
import { ghUsage } from './gh.ts'
import * as kits from './kits.ts'
const importsMs = performance.now() // every module above has loaded and run its top level by here
startStallProfiler().catch(e => console.error('stall profiler', e)) // before startup work, so boot stalls are explained too
try { backfillStartedBy() } catch (e) { console.error('backfill started_by', e) }

// This profile's accounts for everything perch starts (claude, gh, terminals).
applyProfileEnv()
// Every claude, hook and MCP process perch starts names its owner from this (owner.ts).
process.env.PERCH_OWNER_NAME = settings.owner?.name?.trim() || detectOwnerName()

// Last line of defence: a stray error in background work (a GitHub timeout, a bad transcript)
// is recorded and shown in Settings → Health instead of taking the whole server down.
process.on('unhandledRejection', e => { console.error('unhandled rejection', e); try { recordError('background', e) } catch {} })
process.on('uncaughtException', e => { console.error('uncaught exception', e); try { recordError('background', e) } catch {} })
// Being stopped on purpose leaves a row saying how (Settings → Health → Availability).
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => { noteStop(sig); process.exit(0) })

const PORT = Number(process.env.PERCH_PORT ?? settings.port)
const WEB = join(import.meta.dirname, '../web/dist')
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1:5173', 'localhost:5173'])
const allowedHost = (h: string) => LOCAL_HOSTS.has(h) || (settings.remote.enabled && lanHosts(PORT).hosts.includes(h)) || (settings.mobile.tailscale && !!tailscale.host && (h === tailscale.host || h === `${tailscale.host}:443`))

// ---------- live updates (SSE) ----------
const streams = new Set<ServerResponse>()
function broadcast(what: string) {
  for (const s of streams) s.write(`data: ${JSON.stringify({ what })}\n\n`)
}
onChange.add(broadcast)
onListChange.add(() => broadcast('conversations')) // a background rebuild of the list changed what it shows
onChatsChange.add(() => broadcast('chats'))
onTermsChange.add(() => broadcast('terms'))
onBrowserChange.add(() => broadcast('browser'))
onBrowserChange.add(() => { const before = writes; for (const a of approvals.values()) captureApproval(a); if (writes !== before) broadcast('home') })
onTermsChange.add(() => {
  const before = writes
  for (const t of listTerms()) if (t.needsUser && !t.exited) reportNeed({ key: `terminal:${t.id}`, source: 'terminal', title: t.needsUser, context: `Terminal ${t.id}: ${t.title}. Check whether the human-only step still applies; the owning agent must verify completion.`, conversation_id: t.owner ?? t.conversationId })
  if (writes !== before) broadcast('home')
})
onResearch.add(() => broadcast('product-research'))
onPrFlow.add(() => broadcast('prflow'))
// Custom titles set before they were searchable.
for (const r of all<any>('select id from user_state where title is not null')) refreshMeta(r.id)
// Chats that kept running while perch was down: reattach. One that died mid-turn (a reboot) is
// told to carry on, if perch started it; terminal sessions are never written to behind your back.
{
  const n = reattachChats(id => {
    if (!get('select 1 from perch_started where id = ?', id)) return
    setTimeout(() => send({ id, prompt: 'auto-m8 restarted while you were working, and your last turn was cut off. Check where things stand (files, git, running jobs) and continue where you left off.', resume: true }), 3000)
  })
  if (n) console.log(`reattached ${n} running chat${n > 1 ? 's' : ''}`)
}
onPresence.add(() => broadcast('prs'))
onPrSections.add(() => broadcast('prs'))
onCanvas.add(() => broadcast('canvas'))
onDocs.add(() => broadcast('docs'))
onCanvasData.add(() => broadcast('canvasdata'))
onPromises.add(() => broadcast('conversations'))
// Promises agents made: caught from their replies, followed up when due.
setInterval(() => { try { scanForPromises(); if (!isPaused()) tickPromises({ resume: (id, prompt) => send({ id, prompt, resume: true }), isRunning: id => chats.get(id)?.state === 'running' }) } catch (e) { console.error('promises', e) } }, 60_000).unref()
setTimeout(() => prFlow(90).catch(() => {}), 60_000).unref()
// PRs agents open get a shepherd the moment a comment lands or CI goes red.
startShepherd(id => chats.get(id)?.state === 'running')
startProof()
startLearn(() => runningChats().filter(c => c.state === 'running').length)
onAutopilot.add(() => { broadcast('autopilot'); broadcast('conversations') })
onEvolve.add(() => broadcast('evolve'))
onFolders.add(() => { broadcast('folders'); broadcast('conversations') })
onOptimize.add(() => broadcast('autoresearch'))
onDelegate.add(() => broadcast('conversations'))
onError.add(() => broadcast('errors'))

// ---------- conversations ----------
type Row = Record<string, any>
const DAY = 86400_000

function conversationDetail(id: string) {
  const c = detail(id)
  if (!c) return null
  // p.* first: when perch has no status for a PR yet, its null url must not overwrite the real one.
  c.prs = all(`select p.*, cp.url, cp.created from conversation_prs cp left join prs p on p.url = cp.url where cp.conversation_id = ? order by cp.created desc`, id)
  c.links = links(id)
  c.tools = all(`select name, server, count(*) n, sum(is_error) errors from tool_calls where conversation_id = ? group by name order by n desc limit 15`, id)
  c.siblings = siblings(id).slice(0, 12)
  return c
}

// ---------- analytics over your own agent usage ----------
function analytics(days: number) {
  const since = Date.now() - days * DAY
  return {
    days,
    // Our own MCP server was called perch before the rename: old and new calls count as one (auto-m8).
    servers: all(`select coalesce(case when server in ('perch', 'auto_m8') then 'auto-m8' else server end, 'built-in') server, count(*) calls, sum(is_error) errors, count(distinct conversation_id) conversations
                  from tool_calls where ts > ? group by 1 order by calls desc`, since),
    tools: all(`select replace(replace(name, 'mcp__perch__', 'mcp__auto-m8__'), 'mcp__auto_m8__', 'mcp__auto-m8__') name, case when server in ('perch', 'auto_m8') then 'auto-m8' else server end server, count(*) calls, sum(is_error) errors
                from tool_calls where ts > ? group by 1 order by calls desc limit 40`, since),
    daily: all(`select date(ts / 1000, 'unixepoch', 'localtime') day, count(*) calls, sum(server is not null) mcp_calls
                from tool_calls where ts > ? group by day order by day`, since),
    sources: all(`select date(started_at / 1000, 'unixepoch', 'localtime') day, source, count(*) n from conversations where started_at > ? group by day, source order by day`, since),
    hours: all(`select cast(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') as integer) hour, count(*) n from conversations where started_at > ? group by hour`, since),
    // Requests that start the same way, a cheap first signal for "what do I keep repeating".
    // Only what you asked: automated runs (scouts, shepherds, workflows) and searches don't count.
    repeats: all(`select lower(substr(first_prompt, 1, 48)) prefix, count(*) n, max(updated_at) last, group_concat(id) ids
                  from conversations c where started_at > ? and first_prompt is not null
                    and not (source = 'posthog-task' and coalesce(origin, '') not in ('slack', 'user_created', 'posthog_ai', 'signals_chat', 'support_reply', ''))
                    and first_prompt not like '[sandbox_prompt:%'
                    and not exists (select 1 from labels l where l.conversation_id = c.id and l.label in ('search', 'shepherd'))
                  group by prefix having n > 1 order by n desc limit 20`, since),
    projects: all(`select cwd, count(*) n, sum(messages) messages from conversations where started_at > ? and cwd is not null group by cwd order by n desc limit 15`, since),
    skills: all(`select detail name, count(*) calls from tool_calls where name = 'Skill' and detail is not null and ts > ? group by detail order by calls desc limit 20`, since),
    agents: all(`select detail name, count(*) calls from tool_calls where name in ('Agent', 'Task') and detail is not null and ts > ? group by detail order by calls desc limit 12`, since),
    since,
  }
}

// ---------- http plumbing ----------
async function body(req: IncomingMessage): Promise<Row> {
  let data = ''
  for await (const chunk of req) data += chunk
  return data ? JSON.parse(data) : {}
}
// A GET answer carries an ETag of its body; a page that already holds that body (useLive sends
// If-None-Match) gets an empty 304 and skips the download, the parse and the re-render. Most polls
// and live-update refetches return exactly what the page already has.
function json(res: ServerResponse, code: number, value: unknown, req?: IncomingMessage) {
  const text = JSON.stringify(value)
  if (req?.method === 'GET' && code === 200) {
    const tag = String(res.getHeader('ETag') ?? `"${createHash('sha1').update(text).digest('base64url').slice(0, 20)}"`)
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }); return void res.end() }
    res.writeHead(code, { 'Content-Type': 'application/json', ETag: tag, 'Cache-Control': 'no-store' })
  } else res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(text)
}
const MIME: Record<string, string> = { '.webmanifest': 'application/manifest+json', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
function serveStatic(path: string, res: ServerResponse) {
  let file = normalize(join(WEB, path))
  if (!file.startsWith(WEB) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB, 'index.html')
  if (!existsSync(file)) return json(res, 503, { error: 'UI not built. Run npm run build.' })
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000' })
  res.end(readFileSync(file))
}

// Host must be perch itself (stops DNS rebinding); Origin, when sent, must be the same host.
// Anything not on the loopback interface must also carry a paired device's cookie.
function allowed(req: IncomingMessage) {
  const host = req.headers.host ?? ''
  if (!allowedHost(host)) return false
  const origin = req.headers.origin?.replace(/^https?:\/\//, '')
  if (origin && origin !== host && !LOCAL_HOSTS.has(origin)) return false
  return isLoopback(req) || !!deviceFor(req)
}

type Handler = (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => unknown
const routes: [string, RegExp, Handler][] = []
const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:(\w+)/g, '([^/]+)')}$`), h])

route('GET', '/api/health', () => ({ ok: true, pid: process.pid }))
route('GET', '/api/resources', () => localResources())
// Live latency: per-route percentiles, slowest traces with where the time went, requests still
// running, event-loop delay, background SQLite, recent stalls and the Mac's pressure (latency.ts).
route('GET', '/api/latency', async (_m, _req, _res, q) => {
  const seconds = Math.max(10, Math.min(3600, Number(q?.get('seconds')) || 300))
  const machine = await localResources().catch(() => null)
  const stalls = all<any>(`select at, ms, cause, detail from availability where kind = 'stall' and at > ? order by at desc limit 50`, Date.now() - seconds * 1000)
  return latencyReport({ seconds, machine, stalls, route: q?.get('route') ?? undefined })
})
// Durable traces (tracestore.ts): history by build, condensed to hourly summaries as raw expires.
route('GET', '/api/traces', (_m, _r, _s, q) => {
  const n = (k: string) => { const v = q.get(k); return v == null || v === '' ? undefined : Number(v) }
  const t = (k: string) => { const v = q.get(k); if (!v) return undefined; const x = /^\d+$/.test(v) ? Number(v) : Date.parse(v); return Number.isFinite(x) ? x : undefined }
  return traceQuery({ action: q.get('action') ?? undefined, from: t('from'), to: t('to'), hours: n('hours'), name: q.get('name') ?? undefined, kind: q.get('kind') ?? undefined, build: n('build'), id: n('id'), limit: n('limit'), bucket: q.get('bucket') ?? undefined })
})
route('POST', '/api/traces/client', async (_m, req) => ({ recorded: recordClient((await body(req)).events as any) }))
route('GET', '/api/availability', (_m, _r, _s, q) => availability(Number(q.get('hours')) || 24))
route('POST', '/api/availability', async (_m, req) => noteOutage(await body(req)))
// The way to restart perch for new server code: says why, then stops; the shell starts it again
// in about a second and running chats reattach. scripts/restart.sh calls this.
const restarts = restartQueue({ restart: reason => { writeReason(reason.slice(0, 2000)); process.kill(process.pid, 'SIGTERM') } })
route('POST', '/api/restart', async (_m, req, res) => {
  if (!isLoopback(req)) return { error: 'only from the Mac' }
  const b = await body(req)
  const r = restarts.request(String(b.reason ?? 'restart requested').slice(0, 300), !!b.now)
  if (r.queued) return { ok: true, pid: process.pid, ...r }
  writeReason(r.reason.slice(0, 2000))
  res.on('finish', () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50))
  return { ok: true, pid: process.pid, queued: false }
})
route('GET', '/api/restart', () => ({ pending: restarts.pending() }))
route('GET', '/api/events', (_m, req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(': hi\n\n')
  streams.add(res)
  req.on('close', () => streams.delete(res))
  return undefined
})
route('GET', '/api/conversations', (_m, _r, _s, q) => list({
  q: q.get('q') ?? '', states: q.get('states')?.split(',').filter(Boolean), source: q.get('source') ?? undefined,
  sort: q.get('sort') ?? undefined, limit: Number(q.get('limit') ?? 400),
}))
route('POST', '/api/conversations/state', async (_m, req) => { const b = await body(req); setStates(b.ids, b); broadcast('conversations'); return { ok: true } })
route('POST', '/api/labels', async (_m, req) => { const b = await body(req); editLabels(b.ids, b.add, b.remove); broadcast('conversations'); return { ok: true } })
route('GET', '/api/labels', () => ({ labels: allLabels() }))
route('GET', '/api/rules', () => ({ rules: listRules() }))
route('POST', '/api/rules', async (_m, req) => { const id = saveRule(await body(req)); broadcast('conversations'); return { id } })
route('DELETE', '/api/rules/:id', m => { deleteRule(m[1]); return { ok: true } })
route('POST', '/api/rules/preview', async (_m, req) => { const b = await body(req); const r = list({ q: b.query, limit: 50 }); return { n: r.conversations.length, sample: r.conversations.slice(0, 8).map(c => c.title ?? c.first_prompt) } })
route('GET', '/api/pause', () => pauseOverview())
route('POST', '/api/pause', async (_m, req) => { const b = await body(req); const r = pauseAll(typeof b.reason === 'string' && b.reason ? b.reason : undefined); broadcast('home'); broadcast('conversations'); return r })
route('POST', '/api/resume', async (_m, req) => { const b = await body(req); const r = resumeAll({ restart: b.restart !== false }); broadcast('home'); broadcast('conversations'); return r })
route('GET', '/api/home', () => home())
route('GET', '/api/prod-alerts', () => ({ alerts: openProdAlerts() }))
route('GET', '/api/needs', () => needsList())
route('GET', '/api/needs-credit', () => ({ credits: credits() }))
route('GET', '/api/needs/:id', m => ({ item: need(m[1]), history: needHistory(m[1]) }))
route('POST', '/api/needs', async (_m, req) => { const b = await body(req); const r = reportNeed(b as Parameters<typeof reportNeed>[0]); broadcast('home'); return r })
route('POST', '/api/needs/:id/update', async (m, req) => { const b = await body(req); const r = updateNeed(m[1], b as Parameters<typeof updateNeed>[1], b.reviewer_id ?? 'agent'); if (b.attention === 'used' || b.attention === 'wasted') recordAttention(m[1], b.attention); broadcast('home'); broadcast('conversations'); return r })
route('POST', '/api/needs/:id/recheck', async (m, req) => {
  const b = await body(req)
  if (b.evidence !== undefined && typeof b.evidence !== 'string') throw new Error('Evidence must be text')
  recheckNeed(m[1], Date.now(), b.evidence)
  broadcast('home')
  return { ok: true }
})
route('POST', '/api/needs/:id/dismiss', async m => { const r = updateNeed(m[1], { status: 'dismissed', evidence: 'Marked not needed by you.' }, 'user'); recordAttention(m[1], 'wasted'); broadcast('home'); return r })
route('POST', '/api/needs/:id/resolve', async m => { recheckNeed(m[1], Date.now(), 'The user says they resolved their part. Verify it and resume the owning work if safe.'); broadcast('home'); return { ok: true } })
route('GET', '/api/decisions', (_m, _r, _s, q) => ({ decisions: q.get('conversation') ? decisionsFor(q.get('conversation')!) : openDecisions(), ...(q.get('log') ? { decided: autoDecided() } : {}) }))
route('POST', '/api/decisions/:id/answer', async (m, req) => { const r = answerDecision(m[1], String((await body(req)).answer ?? '')); broadcast('home'); broadcast('conversations'); return r })
route('GET', '/api/projects', () => ({ projects: projects() }))
route('GET', '/api/projects/:conversation', m => projectStatus(decodeURIComponent(m[1])) ?? { error: 'no project' })
route('POST', '/api/projects/:conversation/plan-board', m => ({ board_id: ensurePlanBoard(decodeURIComponent(m[1])) }))
route('POST', '/api/brief', async () => { broadcast('home'); const b = await generateBrief(); broadcast('home'); return b })
route('GET', '/api/notes/:day', m => get('select day, body, updated_at from notes where day = ?', m[1]) ?? { day: m[1], body: '' })
route('PUT', '/api/notes/:day', async (m, req) => {
  const { body: text } = await body(req)
  run('insert into notes (day, body, updated_at) values (?, ?, ?) on conflict(day) do update set body = excluded.body, updated_at = excluded.updated_at', m[1], String(text ?? ''), Date.now())
  return { ok: true }
})
route('GET', '/api/notes', (_m, _r, _s, q) => {
  const term = (q.get('q') ?? '').trim()
  return { notes: term ? all(`select day, body from notes where body like ? order by day desc limit 20`, `%${term}%`) : all(`select day, substr(body, 1, 400) body from notes where body != '' order by day desc limit 60`) }
})
route('POST', '/api/ask', async (_m, req, res) => {
  const { question } = await body(req)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const stop = ask(String(question), ev => { res.write(`data: ${JSON.stringify(ev)}\n\n`); if (ev.type === 'perch_done') res.end() })
  req.on('close', () => { if (!res.writableEnded) stop() })
  return undefined
})
route('GET', '/api/conversations/:id', m => conversationDetail(decodeURIComponent(m[1])) ?? { error: 'not found' })
route('GET', '/api/conversations/:id/messages', (m, req, res, q) => {
  markSeen(decodeURIComponent(m[1]))
  const c = get<Row>('select path from conversations where id = ?', decodeURIComponent(m[1]))
  const notices = noticesFor(decodeURIComponent(m[1]))
  // Unchanged transcript and notes: answer before building (and serialising) a thread that can be tens of MB.
  const st = c?.path ? statSync(c.path, { throwIfNoEntry: false }) : undefined
  // ?tail=N: only the last N items, for the first paint of a long thread (the whole one follows).
  const tail = Math.max(0, Number(q.get('tail')) || 0)
  const tag = `"m${st?.size ?? 0}.${Math.floor(st?.mtimeMs ?? 0)}.${createHash('sha1').update(JSON.stringify(notices)).digest('base64url').slice(0, 10)}${tail ? `.t${tail}` : ''}"`
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }); res.end(); return undefined }
  res.setHeader('ETag', tag)
  const items: any[] = c?.path && st ? itemsOf(c.path) : []
  // perch's saved notes, placed where they happened in the thread.
  for (const n of notices) {
    const i = items.findIndex(it => (it.ts ?? 0) > n.at)
    items.splice(i < 0 ? items.length : i, 0, { kind: 'notice', text: n.text, ts: n.at })
  }
  if (tail) return { items: items.slice(-tail), partial: items.length > tail }
  return { items }
})
route('POST', '/api/conversations/:id/title', async (m, req) => {
  const t = String((await body(req)).title ?? '').trim()
  // Empty puts back the automatic title.
  if (t) setTitle(decodeURIComponent(m[1]), t); else run('update user_state set title = null where id = ?', decodeURIComponent(m[1]))
  refreshMeta(decodeURIComponent(m[1])); broadcast('conversations'); return { ok: true }
})
route('POST', '/api/conversations/:id/seen', m => { markSeen(decodeURIComponent(m[1])); return { ok: true } })
route('POST', '/api/conversations/:id/state', async (m, req) => { setStates([decodeURIComponent(m[1])], await body(req)); broadcast('conversations'); return { ok: true } })
route('POST', '/api/conversations/:id/links', async (m, req) => {
  const b = await body(req)
  link(decodeURIComponent(m[1]), b.to, b.kind ?? 'manual', b.note)
  broadcast('conversations')
  return { ok: true }
})
route('DELETE', '/api/conversations/:id/links/:other', m => {
  const [a, b] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])]
  run('delete from links where (a = ? and b = ?) or (a = ? and b = ?)', a, b, b, a)
  broadcast('conversations')
  return { ok: true }
})
route('GET', '/api/related', (_m, _r, _s, q) => ({ related: related(q.get('q') ?? '', { exclude: q.get('exclude') ?? undefined, limit: 5 }) }))
route('GET', '/api/conversations/:id/family', m => family(decodeURIComponent(m[1])))
route('GET', '/api/conversations/:id/siblings', m => ({ siblings: siblings(decodeURIComponent(m[1])) }))
route('GET', '/api/graph', () => ({
  links: all('select a, b, kind, note from links'),
  // Implicit edges: conversations that share a created PR.
  shared: all(`select x.conversation_id a, y.conversation_id b, x.url from conversation_prs x join conversation_prs y
               on x.url = y.url and x.conversation_id < y.conversation_id`),
}))

// The web outbox retries a message until perch answers; a retry of one perch already took returns the first answer.
const chatKeys = new Map<string, { at: number; out: Promise<unknown> }>()
route('POST', '/api/chat', async (_m, req) => {
  const b = await body(req)
  const key = typeof b.clientKey === 'string' ? b.clientKey : ''
  if (!key) return startChat(b)
  for (const [k, v] of chatKeys) if (Date.now() - v.at > 864e5) chatKeys.delete(k)
  const seen = chatKeys.get(key)
  if (seen) return seen.out
  const out = startChat(b)
  chatKeys.set(key, { at: Date.now(), out })
  out.catch(() => chatKeys.delete(key))
  return out
})
async function startChat(b: Row) {
  // A conversation carried over from another profile, or one from Cursor, has no Claude session to resume: replying starts a
  // new chat with it pulled in as context.
  if (b.id && ['import', 'cursor'].includes(get<Row>('select source from conversations where id = ?', b.id)?.source)) { b.contextIds = [b.id, ...(b.contextIds ?? [])]; b.id = undefined }
  let prompt = String(b.prompt ?? '')
  // A new chat that names a PR goes where the PR's other conversations are: into the one that opened it,
  // or a fresh chat with the related ones pulled in. Send noRoute to opt out.
  let routed: string | null = null, prNote = ''
  // A clean chat (context off) gets nothing pulled in: no PR routing, no other conversations.
  if (!b.id && b.context === false) { b.noRoute = true; b.contextIds = [] }
  if (!b.id && !b.noRoute) {
    const plan = planForPrompt(prompt)
    if (plan.reuse) { b.id = plan.reuse; routed = plan.reuse }
    else if (plan.contextIds.length) b.contextIds = [...new Set([...(b.contextIds ?? []), ...plan.contextIds])]
    prNote = plan.status
  }
  if (prNote) prompt = `<pr-status>\n${prNote}\n</pr-status>\n\n${prompt}`
  if (b.contextIds?.length) prompt = `${contextBlock(b.contextIds)}\n\n${prompt}`
  // Links and text dragged or pasted in from the browser, already resolved to their context.
  if (b.shared?.length) prompt = `<shared-from-browser>\n${b.shared.map((x: any) => `${x.context}\n${x.url ?? ''}`.trim()).join('\n\n')}\n</shared-from-browser>\n\n${prompt}`
  const att = attachmentParts(b.attachments ?? [])
  if (att.note) prompt = `${att.note}\n\n${prompt}`
  const inFolder = b.folderId ? get<Row>('select * from folders where id = ?', b.folderId) : null
  // Only the web app (its outbox always sends a clientKey) or a caller that says so counts as you. Agents and scripts
  // curling this endpoint (smoke tests, probes) start agent chats, which stay out of your lists. Send by to label them.
  const by = typeof b.by === 'string' && /^[a-z][a-z-]{1,30}$/.test(b.by) ? b.by : b.clientKey ? 'you' : 'agent'
  // You writing in a thread an agent started makes it yours: it joins your lists.
  if (b.id && by === 'you') run(`update perch_started set by = 'you' where id = ? and coalesce(by, '') != 'you'`, b.id)
  const id = send({ by, id: b.id, cwd: b.cwd ?? inFolder?.cwd ?? undefined, prompt, selectionText: String(b.prompt ?? ''), images: att.images, mode: b.mode, context: b.context !== false, turbo: typeof b.turbo === 'boolean' ? b.turbo : undefined, engine: typeof b.engine === 'string' ? b.engine : undefined })
  if (inFolder && !b.id) editLabels([id], [inFolder.label])
  for (const other of b.contextIds ?? []) link(id, other, 'context')
  // A new chat started while focused belongs to the focus: give it the area's label.
  if (!b.id && settings.focus.active) {
    const tags = settings.focus.areas.flatMap(a => [...a.query.matchAll(/(?:^|\s)#([\w./-]+)/g)].map(m => m[1]))
    if (tags.length) editLabels([id], [tags[0]])
  }
  broadcast('conversations')
  return { id, routed: !!routed }
}
route('GET', '/api/promises', () => ({ promises: openPromises() }))
route('POST', '/api/promises/:id/nudge', m => { nudge(decodeURIComponent(m[1]), (id, prompt) => send({ id, prompt, resume: true, manual: true })); return { ok: true } })
route('GET', '/api/conversations/:id/promises', m => ({ promises: promisesOf(decodeURIComponent(m[1])) }))
route('POST', '/api/promises/:id/drop', m => { dropPromise(decodeURIComponent(m[1])); return { ok: true } })
route('GET', '/api/boards', (_m, _r, _s, q) => ({ boards: listBoards(q.get('q') ?? '') }))
route('POST', '/api/boards', async (_m, req) => { const b = await body(req); return createBoard(b.name, b.about, b.created_by, b) })
route('GET', '/api/boards/:id', m => getBoard(decodeURIComponent(m[1])) ?? { error: 'No such board' })
route('POST', '/api/boards/:id', async (m, req) => updateBoard(decodeURIComponent(m[1]), await body(req)))
route('POST', '/api/boards/:id/activity', m => ({ ok: useBoard(decodeURIComponent(m[1])) }))
route('POST', '/api/boards/:id/delete', m => { deleteBoard(decodeURIComponent(m[1])); return { ok: true } })
// Sharing a board elsewhere (share.ts): targets, who it can go to there, and where it's been shared.
route('GET', '/api/share/targets', async () => ({ targets: await shareTargets() }))
route('GET', '/api/share/:target/audiences', async m => { try { return { audiences: await shareAudiences(decodeURIComponent(m[1])) } } catch (e: any) { return { error: e.message } } })
route('GET', '/api/boards/:id/shares', m => ({ shares: sharesOf(decodeURIComponent(m[1])) }))
route('GET', '/api/boards/:id/share-status', async (m, _r, _s, q) => ({ shares: await shareStatus(decodeURIComponent(m[1]), q.get('fresh') === '1') }))
route('POST', '/api/boards/:id/share', async (m, req) => { const b = await body(req); try { return await shareBoard(decodeURIComponent(m[1]), String(b.target ?? 'posthog'), { audience: b.audience || undefined, overwrite: !!b.overwrite }) } catch (e: any) { return { error: e.message } } })
route('POST', '/api/boards/:id/share/forget', async (m, req) => { const b = await body(req); return { ok: forgetShare(decodeURIComponent(m[1]), String(b.target)) } })
route('POST', '/api/boards-tile', async (_m, req) => putTile(await body(req)))
route('POST', '/api/boards-tile/copy', async (_m, req) => { const b = await body(req); return copyTile(b.tile_id, b.board_id) })
route('GET', '/api/chat-board/:id', m => ({ board: chatBoard(decodeURIComponent(m[1])) }))
route('POST', '/api/chat-board/:id', async (m, req) => { const b = await body(req); showBoard(decodeURIComponent(m[1]), b.board_id ?? null, b.layout); return { ok: true } })
route('GET', '/api/canvas/:folder', m => ({ tiles: canvasTiles(decodeURIComponent(m[1])) }))
route('POST', '/api/canvas/tile', async (_m, req) => { const b = await body(req); requireCanvas(b.folder_id); return saveTile(b as any) })
route('POST', '/api/canvas/tile/:id/delete', m => { removeTile(decodeURIComponent(m[1])); return { ok: true } })
route('POST', '/api/canvas/tile/:id/report', async (m, req) => { reportTile(decodeURIComponent(m[1]), (await body(req)).error ?? null); return { ok: true } })
route('POST', '/api/canvas/data', async (_m, req) => { const r = await canvasData(await body(req)); return { data: r.v, at: r.at, stale: r.stale } })
route('POST', '/api/canvas/make', async (_m, req) => {
  const b = await body(req)
  requireCanvas(b.folder_id)
  useBoard(b.folder_id)
  return makeTile(b as any, () => requireCanvas(b.folder_id))
})
route('GET', '/api/conversations/:id/carry', (m, _r, _s, q) => carryText(decodeURIComponent(m[1]), q.get('mode') === 'full' ? 'full' : 'brief'))
route('POST', '/api/conversations/:id/carry', async (m, req) => { const b = await body(req); return carryTo(decodeURIComponent(m[1]), String(b.to ?? ''), b.mode === 'full' ? 'full' : 'brief') })
route('POST', '/api/import', async (_m, req) => { const r = importCarry((await body(req)) as any); broadcast('conversations'); return r })
route('GET', '/api/profile', () => ({ current: profile.id, profiles: profiles().map(p => ({ id: p.id, label: p.label, color: p.color, port: p.port, enabled: p.enabled })) }))
route('GET', '/api/profile/:id/status', async m => { const p = profiles().find(x => x.id === m[1]); if (!p) throw new Error('No such profile.'); return { ...await readiness(p), claudeDir: p.claudeDir, ghDir: p.ghDir } })
route('POST', '/api/profile/:id/enable', async (m, req) => { const on = (await body(req)).on !== false; saveProfiles(ps => ps.map(p => p.id === m[1] ? { ...p, enabled: on } : p)); return { ok: true } })
route('POST', '/api/skills/:name/carry', async (m, req) => carrySkill(decodeURIComponent(m[1]), String((await body(req)).to ?? '')))
route('POST', '/api/skills/import', async (_m, req) => importSkill((await body(req)) as any))
route('GET', '/api/runtimes', async (_m, _req, _res, q) => ({ text: await describeRuntimes(q?.get('task') ?? undefined, { repoOwner: q?.get('owner') ?? undefined }) }))
route('GET', '/api/mcp-access', async (_m, _req, _res, q) => ({ text: await mcpAccess(q?.get('server') ?? undefined) }))
route('GET', '/api/usage', (_m, _r, _s, q) => usageSummary(Number(q.get('days') ?? 30)))
// AI spend across every account: transcripts priced at API rates, plus scouts' cloud spend.
route('GET', '/api/spend', (_m, _r, _s, q) => spendSummary(Math.min(365, Number(q.get('days')) || 30), q.get('subscription') || undefined))
route('GET', '/api/spend/scouts', (_m, _r, _s, q) => localScoutSpend(Math.min(365, Number(q.get('days')) || 30)))
// Per PR: writing, investigation, shepherd, review bots and prod verify scouts (local transcripts + PostHog LLM analytics).
route('GET', '/api/spend/prs', (_m, _r, _s, q) => prSpend(Math.min(365, Number(q.get('days')) || 30), Math.min(2000, Number(q.get('limit')) || 500)))
route('GET', '/api/spend/pr', (_m, _r, _s, q) => prSpendDetail(q.get('url') ?? '', q.get('days') === 'all' ? null : Math.min(365, Number(q.get('days')) || 30), q.get('timeline') === '1'))
// Shadow mode: replay a shipped PR's writing chat on other models and judge whether they'd have got there for less.
route('GET', '/api/race', () => raceInsights())
route('GET', '/api/race/run', (_m, _r, _s, q) => raceDetail(q.get('id') ?? '') ?? { error: 'No such race.' })
route('POST', '/api/race', async (_m, req) => { const b = await body(req); return startRaceRun({ task: String(b.task ?? ''), cwd: String(b.cwd ?? settings.chat.cwd), models: Array.isArray(b.models) ? b.models.map(String) : undefined, verify: b.verify ? String(b.verify) : undefined, base: b.base ? String(b.base) : undefined, requester: b.requester ? String(b.requester) : undefined, picked: b.picked ? String(b.picked) : undefined, mcp: !!b.mcp, autoCandidate: b.auto_candidate ? String(b.auto_candidate) : undefined }) })
route('POST', '/api/race/skip', async (_m, req) => { const b = await body(req); const out = skipCandidate(String(b.auto_candidate ?? ''), String(b.requester ?? ''), String(b.reason ?? '')); broadcast('race'); return out })
route('GET', '/api/shadow', () => shadowOverview())
route('GET', '/api/shadow/next', async () => ({ url: await shadowPick() }))
route('GET', '/api/shadow/pr', (_m, _r, _s, q) => shadowForPr(q.get('url') ?? ''))
route('GET', '/api/learn', () => learnReport())
route('POST', '/api/shadow/run', async (_m, req) => { const b = await body(req); if (!b.url) return { error: 'Which PR?' }; return startShadowRun(String(b.url), 'manual', Array.isArray(b.models) ? b.models.map(String) : undefined) })
route('POST', '/api/spend/rescan', () => { scanTranscripts(); return { ok: true } })
route('GET', '/api/conversations/:id/usage', m => {
  const id = decodeURIComponent(m[1])
  const u = chatUsage(id)
  if (u.turns) return { ...u, measured: true }
  // Run outside perch (a terminal session): no cost report, but the transcript records tokens per model.
  const c = get<Row>('select path from conversations where id = ?', id)
  if (!c?.path || !existsSync(c.path)) return { ...u, measured: false }
  const seen = new Set<string>(), byModel: Record<string, { turns: number; cost: number; tokens: number }> = {}
  let context = 0
  for (const line of readFileSync(c.path, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue
    let e: any; try { e = JSON.parse(line) } catch { continue }
    const msg = e.message, us = msg?.usage
    if (e.type !== 'assistant' || !us || !msg.model || msg.model === '<synthetic>' || seen.has(msg.id)) continue
    seen.add(msg.id)
    const b = byModel[msg.model] ??= { turns: 0, cost: 0, tokens: 0 }
    b.turns++; b.tokens += (us.input_tokens ?? 0) + (us.output_tokens ?? 0) + (us.cache_read_input_tokens ?? 0) + (us.cache_creation_input_tokens ?? 0)
    context = (us.input_tokens ?? 0) + (us.cache_read_input_tokens ?? 0) + (us.cache_creation_input_tokens ?? 0)
  }
  return { turns: seen.size, cost: null, context, byModel: Object.entries(byModel).map(([model, v]) => ({ model, ...v, cost: null })).sort((a, b) => b.tokens - a.tokens), switches: [], measured: false }
})
route('GET', '/api/provider-usage', () => ({ ...usageNow(), claudeSubs: claudeSubsNow() }))
route('GET', '/api/overage', () => overageNow())
route('GET', '/api/routing', () => ({ caps: capsNow(), fallback: settings.local.model || null }))
// How claude is billed (account.ts): your Claude Code login by default, or an Anthropic API key
// kept in the keychain and passed to claude processes as ANTHROPIC_API_KEY.
const claudeBilling = () => {
  const c = status.claude
  return { ...billingStatus(), login: c?.loggedIn ? { email: c.email ?? null, org: c.orgName ?? null, plan: c.planTier ?? c.subscriptionType ?? null } : null }
}
route('GET', '/api/claude-billing', () => claudeBilling())
// Claude subscriptions in this profile (account.ts): each is the CLI's own login in its own folder.
const claudeSubs = async (fresh = false) => {
  await refreshLogins(fresh)
  const active = pickSub()
  return subs().map(s => ({ id: s.id, label: s.label, main: s.main, enabled: s.enabled, pinned: s.pinned, active: s.id === active, login: loginOf(s.id) ?? null, usage: subUsage(s.id) }))
}
route('GET', '/api/claude-subs', async (_m, _req, _res, q) => claudeSubs(q?.get('fresh') === '1'))
route('POST', '/api/claude-subs', async (_m, req) => {
  const s = addSub(String((await body(req)).label ?? '').trim() || 'Claude')
  broadcast('settings')
  return { sub: s, login: startLogin(() => { refreshLogins(true).then(() => broadcast('settings')); loginChanged() }, s.dir) }
})
route('POST', '/api/claude-subs/:id/login', m => {
  const s = subOf(decodeURIComponent(m[1]))
  if (!s.main) shareFolder(s.dir)
  return startLogin(() => { refreshLogins(true).then(() => broadcast('settings')); loginChanged() }, s.main ? undefined : s.dir)
})
route('PUT', '/api/claude-subs/:id', async (m, req) => { const b = await body(req); updateSub(decodeURIComponent(m[1]), { label: b.label, enabled: b.enabled, pinned: b.pinned, move: b.move }); broadcast('settings'); return claudeSubs() })
route('DELETE', '/api/claude-subs/:id', m => { removeSub(decodeURIComponent(m[1])); broadcast('settings'); return claudeSubs() })
route('POST', '/api/claude-billing/key', async (_m, req) => {
  const k = String((await body(req)).key ?? '').trim()
  if (!isLoopback(req)) return { error: 'Save the key from the Mac.' }
  if (!/^sk-ant-api\d*-[\w-]{20,}$/.test(k)) return { error: 'That doesn\'t look like an Anthropic API key. It starts with sk-ant-api.' }
  setAnthropicKey(k); clearCaps()
  broadcast('settings')
  return claudeBilling()
})
route('DELETE', '/api/claude-billing/key', () => { clearAnthropicKey(); clearCaps(); broadcast('settings'); return claudeBilling() })
route('GET', '/api/local', async () => ({ ...await localStatus(), codex: { ...await codexReady(), models: codexModels(), default: codexDefaultModel() } }))
route('POST', '/api/local/pull', async (_m, req) => pullModel(String((await body(req)).model ?? '')))
route('GET', '/api/chat/:id/engine', m => ({ engine: engineFor(decodeURIComponent(m[1])) }))
route('POST', '/api/chat/:id/engine', async (m, req) => { setEngine(decodeURIComponent(m[1]), String((await body(req)).engine ?? '')); return { ok: true } })
route('GET', '/api/chat/:id/turbo', m => ({ turbo: turboFor(decodeURIComponent(m[1])) }))
route('POST', '/api/chat/:id/turbo', async (m, req) => { setTurbo(decodeURIComponent(m[1]), !!(await body(req)).on); return { ok: true } })
route('POST', '/api/chat/:id/rate', async (m, req) => rateLast(decodeURIComponent(m[1]), (await body(req)).rating))
route('GET', '/api/insights/turns', (_m, _r, _s, q) => turnStats(Number(q.get('days') ?? 30)))
route('GET', '/api/slack/drafts/:id', m => getDraft(decodeURIComponent(m[1])) ?? { error: 'That draft is gone.' })
route('GET', '/api/conversations/:id/slack-drafts', m => ({ drafts: draftsFor(decodeURIComponent(m[1])) }))
route('POST', '/api/slack/drafts/:id/send', async (m, req) => { const r = await sendDraft(decodeURIComponent(m[1]), String((await body(req)).text ?? '')); broadcast('conversations'); return r })
route('POST', '/api/slack/drafts/:id/open', async (m, req) => { const r = await draftInSlack(decodeURIComponent(m[1]), String((await body(req)).text ?? '')); broadcast('conversations'); return r })
route('POST', '/api/slack/drafts/:id/edit', async (m, req) => { editDraft(decodeURIComponent(m[1]), String((await body(req)).text ?? '')); return { ok: true } })
route('POST', '/api/slack/drafts/:id/dismiss', m => { dismissDraft(decodeURIComponent(m[1])); broadcast('conversations'); return { ok: true } })
route('POST', '/api/slack/drafts/:id/refresh', async m => refreshContext(decodeURIComponent(m[1])))
route('GET', '/api/sidebar', () => sidebar())
route('GET', '/api/sidebar/recent', (_m, _r, _s, q) => recentPage(Number(q.get('offset') ?? 0), Number(q.get('limit') ?? 15)))
route('GET', '/api/conversations/:id/evidence', m => ({ evidence: evidence(decodeURIComponent(m[1])) }))
route('GET', '/api/conversations/:id/files', m => ({ files: conversationFiles(decodeURIComponent(m[1])) }))
route('GET', '/api/task-output', (_m, _r, _s, q) => taskOutput(String(q.get('path') ?? ''), q.get('summary') === '1'))
route('GET', '/api/files/check', (_m, _r, _s, q) => ({ file: checkFile(String(q.get('path') ?? '')) }))
// Writing: the doc editor (docs.ts). Agents use the same routes through the MCP doc tool, naming themselves in author.
const authorOf = (b: Row): DocAuthor => {
  const a = b.author
  if (a?.kind !== 'agent') return { kind: 'person' }
  const cid = typeof a.conversation_id === 'string' ? a.conversation_id : undefined
  const t = cid ? get<Row>('select coalesce((select title from auto_titles where id = c.id), c.title, c.first_prompt) t from conversations c where id = ?', cid)?.t : null
  return { kind: 'agent', name: String(a.name || (t ? String(t).slice(0, 60) : 'Agent')), conversation_id: cid }
}
const docTry = async <T>(f: () => T | Promise<T>) => { try { return await f() } catch (e: any) { return { error: e.message } } }
route('GET', '/api/docs', () => ({ docs: listDocs(), dir: DOCS_DIR }))
route('POST', '/api/docs', async (_m, req) => { const b = await body(req); return docTry(() => b.path ? openDoc(b.path) : newDoc(b.title)) })
route('GET', '/api/docs/:id', m => docTry(() => { watchDoc(m[1]); return getDoc(m[1]) }))
route('GET', '/api/writing/words', () => ({ words: dictionaryWords() }))
route('POST', '/api/writing/words', async (_m, req) => { const b = await body(req); return editDictionary(typeof b.add === 'string' ? b.add : undefined, typeof b.remove === 'string' ? b.remove : undefined) })
route('POST', '/api/docs/:id', async (m, req) => { const b = await body(req); return docTry(() => updateDoc(m[1], b)) })
route('POST', '/api/docs/:id/save', async (m, req) => { const b = await body(req); return docTry(() => saveDoc(m[1], String(b.text ?? ''), Number(b.rev), authorOf(b), Array.isArray(b.anchors) ? b.anchors : [])) })
route('POST', '/api/docs/:id/edit', async (m, req) => { const b = await body(req); return docTry(() => agentEdit(m[1], String(b.old_text ?? ''), String(b.new_text ?? ''), authorOf({ author: { kind: 'agent', ...b.author } }))) })
route('POST', '/api/docs/:id/comments', async (m, req) => { const b = await body(req); return docTry(() => addComment(m[1], b as any, authorOf(b))) })
route('POST', '/api/doc-comments/:id', async (m, req) => { const b = await body(req); return docTry(() => { if (b.delete) deleteComment(m[1]); else resolveComment(m[1], b.resolved !== false); return { ok: true } }) })
route('POST', '/api/docs/:id/research', async (m, req) => { const b = await body(req); return docTry(() => addResearch(m[1], b as any, authorOf(b))) })
route('POST', '/api/doc-research/:id/delete', m => { deleteResearch(m[1]); return { ok: true } })
route('POST', '/api/docs/:id/versions', async (m, req) => { const b = await body(req); return docTry(() => { const g = getDoc(m[1]); return { id: snapshot(m[1], g.text, g.doc.rev, String(b.label || 'Saved version'), authorOf(b)) } }) })
route('GET', '/api/doc-versions/:id', m => docVersion(m[1]) ?? { error: 'No such version' })
route('POST', '/api/doc-versions/:id/restore', async (m, req) => { const b = await body(req); return docTry(() => restoreVersion(m[1], authorOf(b))) })
route('POST', '/api/docs/:id/slack', async (m, req) => { const b = await body(req); return docTry(() => ({ text: toSlack(typeof b.text === 'string' ? b.text : getDoc(m[1]).text) })) })
route('GET', '/api/writing/pangram', async () => { const k = pangramKey(); return { configured: !!k, balance: k ? await pangramBalance(k) : null } })
route('POST', '/api/writing/pangram', async (_m, req) => {
  const b = await body(req)
  if (!isLoopback(req)) return { error: 'only from the Mac' }
  if (b.clear) { clearPangramKey(); return { configured: false } }
  const key = String(b.key ?? '').trim()
  if (!key) return { error: 'Paste a Pangram API key' }
  // Check it with Pangram before keeping it (listing models costs nothing).
  const r = await fetch('https://text.external-api.pangram.com/models', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15_000) }).catch((e: any) => ({ ok: false, status: 0, statusText: e.message }) as any)
  if (r.status === 401 || r.status === 403) return { error: `Pangram rejected that key (${r.status})` }
  setPangramKey(key)
  return { configured: true, checked: r.ok, note: r.ok ? 'Pangram accepted the key' : `Saved, but Pangram could not be reached to check it (${r.status || r.statusText})` }
})
route('POST', '/api/docs/:id/ai-check', async (m, req) => {
  const b = await body(req), key = pangramKey()
  if (!key) return { error: 'Add a Pangram API key first (the AI check sends the text to Pangram)' }
  return docTry(() => pangramCheck(typeof b.text === 'string' ? b.text : getDoc(m[1]).text, key))
})
route('POST', '/api/files/action', async (_m, req) => { const b = await body(req); return fileAction(String(b.path ?? ''), b.action) })
// The file itself: shown in perch's viewer, or downloaded (download=1), e.g. from your phone.
route('GET', '/api/files/raw', (_m, _req, res, q) => {
  const { file, type } = fileRaw(String(q.get('path') ?? ''))
  const head = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
    'Content-Disposition': `${q.get('download') ? 'attachment' : 'inline'}; filename="${file.name.replace(/"/g, '')}"` }
  // Byte ranges, so videos can seek (and play at all in some players).
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(_req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1
    if (start > end || start >= file.size) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return undefined }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': String(end - start + 1) })
    createReadStream(file.path, { start, end }).pipe(res)
    return undefined
  }
  res.writeHead(200, { ...head, 'Content-Length': String(file.size) })
  createReadStream(file.path).pipe(res)
  return undefined
})
route('POST', '/api/attachments', async (_m, req) => saveAttachment(await body(req)))
route('POST', '/api/chat/:id/interrupt', m => { interrupt(decodeURIComponent(m[1])); return { ok: true } })
route('GET', '/api/chats', () => ({ chats: runningChats() }))
route('POST', '/api/chat/:id/btw', async (m, req, res) => {
  const { question } = await body(req)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const stop = btw(decodeURIComponent(m[1]), String(question), ev => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`)
    if (ev.type === 'perch_done') res.end()
  })
  req.on('close', () => { if (!res.writableEnded) stop() })
  return undefined
})

route('GET', '/api/terms', () => ({ terms: listTerms() }))
route('POST', '/api/terms', async (_m, req) => {
  const b = await body(req)
  let cmd = b.cmd as string | undefined
  let configDir: string | undefined
  let cwd = b.cwd
  if (b.resume) { // open a conversation in the full Claude Code TUI
    const c = get<Row>('select cwd, source from conversations where id = ?', b.resume)
    cwd ??= c?.cwd
    configDir = settings.sources.find(s => s.id === c?.source)?.configDir
    cmd = `claude --resume ${b.resume}`
  }
  if (b.login) { // sign back in: /login in the chat's own Claude config, so the new token is the one it reads
    const c = b.conversationId ? get<Row>('select cwd, source from conversations where id = ?', b.conversationId) : undefined
    cwd ??= c?.cwd
    configDir = settings.sources.find(s => s.id === c?.source)?.configDir
    cmd = 'claude /login'
  }
  // A conversation's terminal (▶ Run on a code block, or an agent's terminal tool): its folder and Claude account,
  // and the conversation owns it, so it's woken when the command finishes or waits for input.
  const owner = typeof b.prefill === 'string' && b.conversationId ? String(b.conversationId) : undefined
  if (owner) {
    const c = get<Row>('select cwd, source from conversations where id = ?', owner)
    cwd ??= c?.cwd
    configDir = settings.sources.find(s => s.id === c?.source)?.configDir
  }
  const t = createTerm({ cwd, cmd, title: b.title, conversationId: b.resume ?? owner, configDir, owner,
    prefill: typeof b.prefill === 'string' ? b.prefill.slice(0, 20_000) : undefined, run: !!b.run, needsUser: b.needsUser ? String(b.needsUser).slice(0, 300) : undefined })
  return { id: t.id }
})
route('DELETE', '/api/terms/:id', m => { closeTerm(m[1]); return { ok: true } })
route('GET', '/api/terms/:id/read', async (m, _req, _res, q) => {
  const t = terms.get(m[1])
  if (!t) return { error: 'No such terminal (closed, or auto-m8 restarted).' }
  const wait = Number(q.get('wait')) || 0
  if (wait > 0) await waitTerm(t, wait * 1000)
  return readTerm(t, { since: q.get('since') ? Number(q.get('since')) : undefined, maxChars: Number(q.get('max')) || undefined })
})
route('POST', '/api/terms/:id/run', m => {
  const t = terms.get(m[1])
  if (!t) return { error: 'No such terminal (closed, or auto-m8 restarted).' }
  try { runPending(t) } catch (e: any) { return { error: e.message } }
  return { ok: true }
})
route('POST', '/api/terms/:id/input', async (m, req) => {
  const t = terms.get(m[1]), b = await body(req)
  if (!t) return { error: 'No such terminal (closed, or auto-m8 restarted).' }
  try { sendTerm(t, String(b.text ?? ''), b.enter !== false) } catch (e: any) { return { error: e.message } }
  return { ok: true }
})
// An owned terminal finishing, waiting or exiting wakes its conversation through the inbox, like any watched event.
termEvents.add((owner, id, event, text) => inboxPush(owner, `term:${id}`, event, text))
// The agent browser: a held click, a takeover, a crash wake the conversation that owns the window.
browserRoutes(route, body)
researchRoutes(route, body)
route('GET', '/api/explore/canvases', () => ({ boards: exploreCanvases() }))
route('GET', '/api/explore/codebases', () => swr('explore-codebases', 10 * 60_000, () => exploreCodebases(), { deadline: 4000 }))
route('POST', '/api/boards/:id/opened', m => { openedBoard(decodeURIComponent(m[1])); return { ok: true } })
route('POST', '/api/boards/:id/thumb', async (m, req) => { try { return saveThumb(decodeURIComponent(m[1]), (await body(req)).jpeg) } catch (e: any) { return { error: e.message } } })
route('GET', '/api/boards/:id/thumb', (m, _req, res) => {
  let file: string | null = null
  try { file = thumbFile(decodeURIComponent(m[1])) } catch {}
  if (!file) { res.writeHead(404); res.end('No preview'); return }
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' })
  createReadStream(file).pipe(res)
})
route('GET', '/api/explore/competitors', () => ({ products: exploreCompetitors() }))
route('GET', '/api/explore/competitors/:id', m => { try { return exploreCompetitor(decodeURIComponent(m[1])) } catch (e: any) { return { error: e.message } } })
browserEvents.add((owner, event, text) => inboxPush(owner, `browser:${owner}`, event, text))
setInterval(pruneRecordings, 6 * 3600_000).unref()
// after startup's busy first seconds (indexing), and once more in case Chrome was slow to answer
// Only chats mid-turn get their windows back at start; the others re-adopt theirs on their next browser call.
const chatBusy = (owner: string) => runningChats().some(c => c.id === owner && c.state === 'running')
setOwnerBusy(chatBusy)
// Agent windows unused for an hour are closed (see browser.ts idleWindows): stale pages were burning ~2 cores.
setInterval(() => { closeIdleWindows().catch(e => console.error('[browser] idle sweep', e?.message)) }, 5 * 60_000).unref()
// Every minute: pause idle agent windows' pages, and keep the Agent Chrome below agents and chats in CPU priority.
setInterval(() => { freezeIdleWindows().catch(e => console.error('[browser] freeze sweep', e?.message)); lowerChromePriority().catch(() => {}) }, 60_000).unref()
const resume = (again: boolean) => resumeBrowser(chatBusy).then(n => { console.log(`agent browser: re-adopted ${n} window(s)`); if (!n && again) setTimeout(() => resume(false), 15_000).unref() }).catch(e => console.error('resumeBrowser', e.message))
setTimeout(() => resume(true), 3000).unref()

route('GET', '/api/remote', () => ({ enabled: settings.remote.enabled, hosts: lanHosts(PORT).hosts, devices: listDevices(), listening: [...lan.keys()] }))
route('POST', '/api/remote/pair', () => startPairing(PORT, settings.mobile.tailscale ? tailscaleUrl() : null))
// ---------- mobile (server/mobile.ts) ----------
route('GET', '/api/mobile', () => mobileStatus())
// Continue in the cloud (server/cloud.ts): a PostHog cloud task owns the conversation while the Mac is away.
const cloud = makeCloud({
  conversation: id => {
    const c = get<any>(`select c.cwd, coalesce(u.title, c.title, c.first_prompt, 'Conversation') t from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)
    return c ? { cwd: chats.get(id)?.cwd ?? c.cwd, title: String(c.t).slice(0, 140), running: chats.get(id)?.state === 'running' } : null
  },
  history: id => carryText(id, 'full').text,
  git: gitInfo,
  startTask: async o => { const t: any = await tasks.start(o); return { task: String(t.id), run: t.latest_run?.id ?? null } },
  taskState: async task => {
    const t: any = await tasks.get(task), r = t.latest_run ?? {}
    const idle = r.id && r.status === 'in_progress' ? idleFromLogs(await tasks.rawLogs(task, r.id).catch(() => [])) : false
    return { status: String(r.status ?? 'queued'), run: r.id ?? null, pr: r.output?.pr_url ?? null, error: r.error_message ?? null, idle }
  },
  taskLogs: (task, run) => tasks.logs(task, run),
  steer: async (task, run, text) => { await tasks.message(task, run, text) },
  resumeLocal: (id, prompt) => { send({ id, prompt, resume: true, by: RETURN_BY }); broadcast('conversations') },
  notify,
  blockers: async (git, history) => { const o = git.repository?.split('/')[0]; return cloudBlockers(needsFrom(history.slice(-6000), { repoOwner: o, dirty: git.untracked.length > 0 })) },
  macAway: async () => (await macIdleMs()) > 3 * 60_000,
  subscriptionReady: () => !allCapped(),
  notice: noticeLive,
})
sendInterceptors.add(o => cloud.intercept(o))
// Every subscription capped: the message goes to a PostHog cloud task instead of the local model.
// If the hand-off fails, the same message goes to the local model as before.
setCloudFallback((opts, id) => {
  void (async () => {
    try {
      if (!leaseFor(id)) await cloud.handOff(id, 'fallback')
      cloud.intercept({ id, prompt: opts.prompt, by: opts.by })
    } catch (e: any) {
      noticeLive(id, `Cloud fallback failed (${e?.message ?? e}); continuing on the local model.`)
      send({ ...opts, id, retry: true, noCloud: true })
    }
  })()
})
route('GET', '/api/cloud', () => ({ leases: leases() }))
route('GET', '/api/cloud/:id', m => { const id = decodeURIComponent(m[1]); return { lease: leaseFor(id), title: get<{ t: string }>(`select coalesce(u.title, c.title, c.first_prompt, '') t from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)?.t ?? '' } })
route('POST', '/api/cloud/:id', async m => { const r = await cloud.handOff(decodeURIComponent(m[1])); broadcast('conversations'); return r })
route('POST', '/api/cloud/:id/back', async (m, _req, _res, q) => { const r = await cloud.bringBack(decodeURIComponent(m[1]), q.get('force') === '1'); broadcast('conversations'); return r })
route('PUT', '/api/mobile/tailscale', async (_m, req) => {
  if (!isLoopback(req)) return { error: 'only from the Mac' }
  const on = !!(await body(req)).on
  await setTailscale(on)
  updateSettings({ mobile: { ...settings.mobile, tailscale: on } } as any)
  syncTailnet(); broadcast('settings')
  return mobileStatus()
})
route('GET', '/api/push/key', () => ({ key: pushKey() }))
route('POST', '/api/push/subscribe', async (_m, req) => pushSubscribe(req, (await body(req)).subscription))
route('POST', '/api/push/unsubscribe', async (_m, req) => { pushUnsubscribe(String((await body(req)).endpoint ?? '')); return { ok: true } })
route('POST', '/api/push/test', () => notify({ title: 'auto-m8', body: 'Notifications work. You will hear from auto-m8 when something needs you and you are away from the Mac.', url: '/#home', tag: 'perch-test' }))
route('POST', '/api/presence', async (_m, req) => { const b = await body(req); beat(req, b.view, b.title); return { ok: true } })
route('GET', '/api/handoff', (_m, req) => ({ handoff: handoff(req) }))
route('GET', '/api/drafts/:id', m => ({ draft: getComposeDraft(decodeURIComponent(m[1])) }))
route('PUT', '/api/drafts/:id', async (m, req) => putDraft(req, decodeURIComponent(m[1]), String((await body(req)).text ?? '')))
route('DELETE', '/api/remote/devices/:id', m => { revokeDevice(m[1]); return { ok: true } })
route('GET', '/api/focus/suggestions', () => focusSuggestions())
route('GET', '/api/conversations/:id/open', m => ({ targets: targets(decodeURIComponent(m[1])) }))
route('POST', '/api/conversations/:id/open', async (m, req) => {
  if (!isLoopback(req)) return { error: 'opens apps on the Mac; use the link on a phone' }
  await openIn(decodeURIComponent(m[1]), (await body(req)).target as Target)
  return { ok: true }
})
// A GitHub link clicked inside the desktop app opens in the default browser via macOS open:
// window.open from the Electron window doesn't reliably reach the browser.
route('POST', '/api/open-url', async (_m, req) => {
  if (!isLoopback(req)) return { error: 'opens the browser on the Mac' }
  const url = String((await body(req)).url ?? '')
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[/?#][^\s]*)?$/.test(url)) return { error: 'only GitHub PR links' }
  await new Promise(r => execFileCb('open', [url], r))
  return { ok: true }
})
route('GET', '/api/settings', () => settings)
route('PUT', '/api/settings', async (_m, req) => {
  const patch = await body(req)
  if (patch.remote && !isLoopback(req)) delete patch.remote // a phone can't open the Mac to more phones
  if (patch.mobile && !isLoopback(req)) delete patch.mobile.tailscale // nor turn on the tailnet address
  const s = updateSettings(patch)
  if (patch.owner) process.env.PERCH_OWNER_NAME = s.owner?.name?.trim() || detectOwnerName()
  if (patch.remote) syncLan()
  broadcast('settings')
  if (patch.focus) broadcast('conversations')
  return s
})
// The window as files (server/layout.ts): which layout shows, and the tiles layouts put in blocks.
writeGuide()
// Every change is kept as a version (layout.ts). A change someone asked for in words is a draft
// until they keep it: `draft` holds the version from before it, so Undo puts that back.
let layoutDraft: { before: string; text: string; at: number; changed: boolean } | null = null
let layoutNextLabel: string | null = null
const activeLayout = () => settings.ui.layout ?? 'default'
const keepVersion = (label?: string) => {
  const id = snapshotLayouts(layoutNextLabel ?? label ?? (layoutDraft ? `Asked: ${layoutDraft.text}` : 'Edited'), activeLayout())
  layoutNextLabel = null
  if (layoutDraft && id && id !== layoutDraft.before) layoutDraft.changed = true
}
try { keepVersion('When auto-m8 started') } catch {}
watchLayouts(() => { try { keepVersion() } catch {} broadcast('layouts') })
route('GET', '/api/layouts', () => ({ ...loadLayout(activeLayout()), active: activeLayout(), layouts: listLayouts(), dir: LAYOUT_DIR, draft: layoutDraft }))
route('GET', '/api/layouts/versions', () => listLayoutVersions())
route('GET', '/api/layouts/gallery', () => sharedLayouts())
// Restores a version: the files and which layout was active.
const restoreLayout = (id: string) => {
  const r = restoreLayoutVersion(id, activeLayout())
  if ('error' in r) return r
  layoutNextLabel = 'Restored a version'
  if (loadLayout(r.active).name === r.active) updateSettings({ ui: { ...settings.ui, layout: r.active } })
  keepVersion(); broadcast('layouts'); broadcast('settings')
  return { ok: true, active: r.active }
}
route('POST', '/api/layouts/restore', async (_m, req) => restoreLayout(String((await body(req)).id ?? '')))
// Someone asked for a change in words: remember the version before it, so it can be undone in one click.
route('POST', '/api/layouts/ask', async (_m, req) => {
  const text = String((await body(req)).text ?? '').trim()
  if (!text) return { error: 'say what to change' }
  const before = snapshotLayouts('Before: ' + text, activeLayout())
  if (!before) return { error: 'could not save a version first' }
  layoutDraft = { before, text, at: Date.now(), changed: false }
  broadcast('layouts')
  return { ok: true, before }
})
route('POST', '/api/layouts/keep', () => { layoutDraft = null; broadcast('layouts'); return { ok: true } })
route('POST', '/api/layouts/undo', () => {
  if (!layoutDraft) return { error: 'nothing to undo' }
  const r = restoreLayout(layoutDraft.before)
  layoutDraft = null; broadcast('layouts')
  return r
})
route('PUT', '/api/layouts/active', async (_m, req) => {
  const name = String((await body(req)).name ?? '')
  const l = loadLayout(name)
  if (l.name !== name) return { error: l.error }
  updateSettings({ ui: { ...settings.ui, layout: name } })
  try { keepVersion(layoutDraft ? undefined : `Switched to ${name}`) } catch {}
  broadcast('layouts'); broadcast('settings')
  return { ok: true, name }
})
route('POST', '/api/layouts/clone', async (_m, req) => {
  const b = await body(req)
  const r = cloneLayout(String(b.from ?? 'default'), String(b.as ?? ''))
  broadcast('layouts')
  return r
})
// The escape hatch: back to the shipped default, whatever the files say.
route('POST', '/api/layouts/reset', () => { updateSettings({ ui: { ...settings.ui, layout: 'default' } }); broadcast('layouts'); broadcast('settings'); return { ok: true } })
route('POST', '/api/layouts/reveal', async (_m, req) => { if (!isLoopback(req)) return { error: 'opens Finder on the Mac' }; await new Promise(r => execFileCb('open', ['-R', join(LAYOUT_DIR, 'AGENTS.md')], r)); return { ok: true } })
route('GET', '/api/layouts/tile', (_m, _req, _res, q) => { const html = readTile(q.get('path')); return html === null ? { error: 'no such tile in the layouts folder' } : { html } })
route('GET', '/api/status', () => ({
  appleNotes: (checkAccess(), notesStatus),
  ...status, claudeLogin, posthog: { ...posthogStatus, hasKey: !!posthogKey() }, index: indexStatus,
  server: { pid: process.pid, port: PORT, url: `http://127.0.0.1:${PORT}` }, chats: runningChats(), terms: listTerms().length,
  // For the setup checklist (web/src/Setup.tsx).
  setup: { owner: process.env.PERCH_OWNER_NAME, cwdExists: existsSync(settings.chat.cwd), cwdIsHome: settings.chat.cwd.replace(/\/+$/, '') === homedir(), chrome: existsSync(settings.browser.chromePath) },
}))
const loginChanged = () => {
  if (claudeLogin.state === 'done') status.claudeAuthLapse = undefined // a fresh sign-in: the next chat process reads it
  broadcast('status')
  if (claudeLogin.state === 'done') refreshBasics().then(() => broadcast('status'))
}
onAuthLapse.add(() => broadcast('status'))
route('POST', '/api/claude/login', async (_m, req) => {
  const b = await body(req)
  const c = b.conversationId ? get<Row>('select source from conversations where id = ?', b.conversationId) : undefined
  return startLogin(loginChanged, settings.sources.find(s => s.id === c?.source)?.configDir)
})
// MCP servers that need OAuth (e.g. the Slack plugin): authorize from auto-m8, no /mcp in a terminal.
onMcpLogin.add(s => { if (s.state === 'done') resetMcpRows(); broadcast('mcp-login') })
route('POST', '/api/mcp/login', async (_m, req) => {
  const server = String((await body(req)).server ?? '')
  if (!/^[\w:. -]{1,80}$/.test(server)) throw new Error('Which MCP server?')
  return startMcpLogin(server)
})
route('POST', '/api/mcp/login/code', async (_m, req) => { const b = await body(req); return submitMcpCode(String(b.server ?? ''), String(b.code ?? '')) })
route('GET', '/api/mcp/login', async (_m, _req, _res, q) => mcpLogins.get(q?.get('server') ?? '') ?? { state: 'idle' })
route('POST', '/api/claude/login/code', async (_m, req) => submitCode(String((await body(req)).code ?? '')))
route('DELETE', '/api/claude/login', () => { cancelLogin(); broadcast('status'); return { ok: true } })
route('POST', '/api/status/refresh', async () => { await Promise.all([refreshBasics(), refreshMcp()]); broadcast('status'); return { ok: true } })
route('POST', '/api/posthog/key', async (_m, req) => {
  const { key } = await body(req)
  if (key) setPosthogKey(String(key).trim()); else clearPosthogKey()
  posthogStatus.user = undefined
  await syncTasks()
  broadcast('status')
  return { ok: posthogStatus.ok, error: posthogStatus.error }
})
route('POST', '/api/reindex', async () => { const n = scanAll(true); await Promise.all([syncTasks(), syncMyPrs().then(syncPrs)]); applyRules(); return { reindexed: n } })
route('GET', '/api/analytics', (_m, _r, _s, q) => analytics(Number(q.get('days') ?? 30)))

route('GET', '/api/skills', (_m, _r, _s, q) => skills.list({ q: q.get('q') ?? '', sort: q.get('sort') ?? 'new', mine: q.get('mine') === 'owned' ? 'owned' : q.get('mine') ? 'created' : false, days: Number(q.get('days') ?? 0) }))
route('POST', '/api/skills/ask', async (_m, req) => skills.ask(String((await body(req)).question ?? '')))
route('GET', '/api/skills/:name', m => skills.get(decodeURIComponent(m[1])))
route('POST', '/api/skills/:name/install', m => skills.install(decodeURIComponent(m[1])))
route('GET', '/api/skills-store/command', () => skills.installCommand())
route('POST', '/api/skills-store/install', () => skills.installStore())
route('POST', '/api/skills-store/install-pasted', async (_m, req) => runStoreCommand(String((await body(req)).command ?? '')))
route('GET', '/api/errors', () => ({ errors: recentErrors() }))
route('GET', '/api/github/budget', () => ghUsage())
route('POST', '/api/errors/:key/resolve', m => { run(`update errors set status = 'resolved' where key = ?`, decodeURIComponent(m[1])); broadcast('errors'); return { ok: true } })
route('POST', '/api/client-errors', async (_m, req) => {
  const b = await body(req)
  const err = Object.assign(new Error(String(b.message ?? 'unknown')), { stack: `${b.stack ?? ''}\n${req.headers['user-agent'] ?? ''}` })
  return recordError(`UI ${String(b.where ?? 'page').slice(0, 40)}`, err, 'Part of the page')
})
route('GET', '/api/scouts', (_m, _r, _s, q) => scouts.list({ q: q.get('q') ?? '', mine: q.get('mine') === '1', sort: q.get('sort') ?? 'recent' }))
route('GET', '/api/scouts/spend', (_m, _r, _s, q) => scouts.spend((q.get('skills') ?? '').split(','), Number(q.get('days')) || 7))
route('GET', '/api/scouts/runs',(_m, _r, _s, q) => scouts.runs(q.get('config') ?? undefined))
route('POST', '/api/scouts/:id/run', m => scouts.run(m[1]))
route('POST', '/api/posthog/tasks', async (_m, req) => { const b = await body(req); return tasks.create(b.title, b.description, b.repository) })

route('POST', '/api/conversations/:id/branch', async (m, req) => { const b = await body(req); const r = fork(decodeURIComponent(m[1]), b.uuid ?? null); scanAll(); broadcast('conversations'); return r })
route('POST', '/api/conversations/:id/rewind', async (m, req) => { const b = await body(req); const r = await rewind(decodeURIComponent(m[1]), String(b.uuid), !!b.files); scanAll(); broadcast('conversations'); return r })
route('POST', '/api/conversations/:id/restore', async (m, req) => restoreFiles(decodeURIComponent(m[1]), Number((await body(req)).turn)))
route('GET', '/api/conversations/:id/snapshots', m => ({ snapshots: snapshotsFor(decodeURIComponent(m[1])) }))
route('POST', '/api/autoresearch', async (_m, req) => { const b = await body(req); if (!b.brief) return { error: 'Describe what to optimise and how to measure it.' }; const r = await startOpt({ ...b, brief: String(b.brief) }); broadcast('conversations'); return r })
route('POST', '/api/delegate', async (_m, req) => { const b = await body(req); try { return await startHelper({ parent: String(b.parent ?? ''), brief: String(b.brief ?? ''), name: b.name, cwd: b.cwd, mode: b.mode, worktree: !!b.worktree, engine: b.engine }) } catch (e: any) { return { error: e.message } } })
route('GET', '/api/worktrees', async (_m, _req, _res, q) => { const f = (q.get('filter') ?? '').toLowerCase(); const list = (await worktreeInventory({ fresh: q.get('fresh') === '1' })).filter(w => !f || [w.path, w.branch, w.pr].some(x => String(x ?? '').toLowerCase().includes(f))); return { worktrees: list, text: describeWorktrees(list), snapshotAgeMs: worktreeSnapshotAge(), lastSweep, limits: WT_LIMITS, helpersInWorktrees: helperWorktreesRunning() } })
route('GET', '/api/git/repos', async () => ({ repos: await gitRepos() }))
route('GET', '/api/git/overview', async (_m, _req, _res, q) => { try { return { repos: await gitOverview({ fresh: q.get('fresh') === '1' }) } } catch (e: any) { return { error: e.message } } })
route('GET', '/api/git/repo', async (_m, _req, _res, q) => { try { return await repoGit(String(q.get('path') ?? ''), { fresh: q.get('fresh') === '1' }) } catch (e: any) { return { error: e.message } } })
route('POST', '/api/worktrees/sweep', async (_m, req) => { const b = await body(req); try { return await sweepWorktrees({ dryRun: !!b.dry_run }) } catch (e: any) { return { error: e.message } } })
route('POST', '/api/worktrees/remove', async (_m, req) => { const b = await body(req); try { return await removeWorktree(String(b.path ?? ''), { force: !!b.force }) } catch (e: any) { return { error: e.message } } })
route('POST', '/api/delegate/:id/send', async (m, req) => { const b = await body(req); try { helperSend(m[1], String(b.message ?? '')); return { ok: true } } catch (e: any) { return { error: e.message } } })
route('POST', '/api/orchestra/watch', async (_m, req) => { const b = await body(req); try { if (b.stop) { const stopped = orchUnwatch(String(b.owner ?? ''), stopTargets(b)); return { ok: true, stopped } } return orchWatch({ owner: String(b.owner ?? ''), targets: b.targets ?? [], events: b.events, idle_minutes: b.idle_minutes }) } catch (e: any) { return { error: e.message } } })
route('POST', '/api/orchestra/board', async (_m, req) => { const b = await body(req); try { return { text: await board(String(b.owner ?? ''), { scope: b.scope, hours: b.hours }) } } catch (e: any) { return { error: e.message } } })
route('GET', '/api/lifecycle/status', () => lifecycleStatus)
route('GET', '/api/lifecycle/:id', m => harvestOf(decodeURIComponent(m[1])) ?? { none: true })
// Close out now, whatever its age: the same pass the sweep makes on stale chats.
route('POST', '/api/lifecycle/:id/harvest', async m => {
  const id = decodeURIComponent(m[1])
  const c = get<any>(`select c.id, c.path, c.cwd, coalesce(u.title, c.title, c.first_prompt, '') title, c.updated_at from conversations c left join user_state u on u.id = c.id where c.id = ?`, id)
  if (!c?.path) return { error: 'No local transcript to read.' }
  const h = await harvestChat(c)
  broadcast('conversations')
  return h ?? { error: "The closing pass couldn't read the conversation. Try again." }
})
route('POST', '/api/relay', async (_m, req) => { const b = await body(req); try { return relay({ from: String(b.from ?? ''), to: String(b.to ?? ''), message: String(b.message ?? ''), reportBack: b.report_back !== false }) } catch (e: any) { return { error: e.message } } })
route('GET', '/api/relay/graph', (_m, _r, _s, q) => relayGraph(Number(q.get('days') ?? 7)))
route('POST', '/api/delegate/:id/stop', m => { stopHelper(m[1]); return { ok: true } })
route('GET', '/api/delegate/for/:conv', m => ({ helpers: helpersOf(decodeURIComponent(m[1])) }))
// Claude Code hooks (scripts/perch-hook.sh): exact Running / waiting-for-permission / done for every session,
// terminal ones included. Read first by the list; the transcript rules and the attention sweep stay the fallback.
route('POST', '/api/hooks/claude', async (_m, req, res) => {
  if (!isLoopback(req)) { json(res, 403, { error: 'only from the Mac' }); return undefined }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const r = handleHookPost(hookSignals, raw)
  if (r.status === 200 && (r.json as any).status !== 'running') broadcast('conversations')
  if (r.status !== 200) { json(res, r.status, r.json); return undefined }
  return r.json
})
route('POST', '/api/conversations/:id/not-needed', m => { dismissAttention(decodeURIComponent(m[1])); broadcast('conversations'); return { ok: true } })
route('GET', '/api/autoresearch', () => ({ runs: listRuns() }))
route('GET', '/api/autoresearch/for/:conv', m => runFor(decodeURIComponent(m[1])) ?? { none: true })
route('POST', '/api/autoresearch/:id/:action', m => { ({ pause: pauseOpt, resume: resumeOpt, stop: stopOpt } as any)[m[2]]?.(m[1]); return { ok: true } })
route('GET', '/api/mcp/wishes', async () => {
  // What agents lacked (server/wishes.ts), grouped into needs, each with what the PostHog MCP registry would connect.
  const r: any = wishNeeds()
  for (const g of r.groups.filter((g: any) => g.kind === 'data').slice(0, 8)) {
    try { const d: any = await discoverMcp(g.suggested || g.name, 3); g.candidates = (d.results ?? d.candidates ?? []).slice(0, 3).map((c: any) => ({ name: c.title ?? c.name, liveness: c.liveness, score: c.combined_score ?? c.score, connect: c.connect?.[0] ?? null, id: c.id ?? c.server_id })) } catch { g.candidates = [] }
  }
  return r
})
route('POST', '/api/mcp/wishes/run', () => { wishCycle(); return { ok: true } })
route('POST', '/api/mcp/wishes/:id/ignore', m => { ignoreNeed(decodeURIComponent(m[1])); return { ok: true } })
route('GET', '/api/applenotes/status', () => { checkAccess(); if (notesStatus.access === 'granted' && !notesStatus.count) readNotes(); return notesStatus })
route('GET', '/api/applenotes/:id', m => { const n = appleNotes().find(x => x.id === decodeURIComponent(m[1])); return n ? { ...n, url: noteUrl(n.id) } : { error: 'not found' } })
route('POST', '/api/applenotes/:id/open', async m => { if (!/^[\w-]+$/.test(m[1])) return { error: 'bad id' }; await new Promise(r => execFileCb('open', [noteUrl(m[1])], r)); return { ok: true } })
route('POST', '/api/applenotes/grant', async () => { await new Promise(r => execFileCb('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], r)); return { ok: true, node: process.execPath } })
route('GET', '/api/compare', (_m, _r, _s, q) => compare((q.get('ids') ?? '').split(',').filter(Boolean).slice(0, 8)))
route('POST', '/api/compare/judge', async (_m, req) => judge(((await body(req)).ids ?? []).slice(0, 8)))
route('POST', '/api/compare/link', async (_m, req) => { const b = await body(req); const keep = linkGroup(b.ids ?? [], b.keep); if (b.archiveOthers) setStates((b.ids ?? []).filter((x: string) => x !== keep), { state: 'archived' }); broadcast('conversations'); return { keep } })
route('POST', '/api/home/snooze', async (_m, req) => {
  const b = await body(req)
  const keys: string[] = (b.keys ?? []).filter(Boolean)
  snooze(keys, Number(b.until), b.reason)
  // A snoozed conversation also leaves the lists until then.
  const convs = keys.filter(k => !k.startsWith('https://'))
  if (convs.length) setStates(convs, { state: 'later', snoozeUntil: Number(b.until) })
  broadcast('home'); broadcast('conversations')
  return { ok: true }
})
route('POST', '/api/pr/push-through', async (_m, req) => { const b = await body(req); const r = await pushThrough(String(b.pr), b.where === 'here' ? 'here' : 'cloud', !!b.force); broadcast('conversations'); return r })
route('GET', '/api/insights/prs', (_m, _r, _s, q) => prFlow(Number(q.get('days') ?? 90)))
// The ↻ button: start a fetch now, even if the last one is under 3 minutes old; 'prflow' fires when it lands.
route('POST', '/api/insights/prs/refresh', async (_m, _r, _s, q) => { const d = await prFlow(Number(q.get('days') ?? 90), false, true); broadcast('prflow'); return { refreshing: !!d?.refreshing } })
route('GET', '/api/prs/sidebar', (_m, _r, _s, q) => prSidebar(q.get('fresh') === '1'))
// Someone is looking at this PR: GitHub answers up to a minute old are fine (the page polls every 30s).
const PR_VIEW_MAX_AGE = 60_000
route('GET', '/api/pr/page', (_m, _r, _s, q) => prPage(String(q.get('url') ?? ''), PR_VIEW_MAX_AGE))
route('GET', '/api/prs/plan', (_m, _r, _s, q) => mergePlan(String(q.get('urls') ?? '').split(',').filter(Boolean)))
// Architecture explorer: a deterministic map of a repo (modules, imports, foreign keys, history) to explore and chat about.
setExploreDir(DATA_DIR)
setSwrDir(join(DATA_DIR, 'swr'))
route('GET', '/api/explore/graph', (_m, _r, _s, q) => exploreGraph(String(q.get('repo') ?? ''), q.get('focus'), q.get('hubs') === '1'))
route('GET', '/api/explore/timeline', (_m, _r, _s, q) => exploreTimeline(String(q.get('repo') ?? ''), q.get('focus')))
route('GET', '/api/explore/node', (_m, _r, _s, q) => exploreNode(String(q.get('repo') ?? ''), String(q.get('id') ?? '')))
route('POST', '/api/explore/dream', async (_m, req) => { const b = await body(req); return exploreDream(String(b.repo ?? ''), b.focus ?? null, Array.isArray(b.ops) ? b.ops : []) })
route('POST', '/api/explore/open', async (_m, req) => { const b = await body(req); return exploreOpen(String(b.repo ?? ''), String(b.file ?? ''), Number(b.line) || undefined) })
// These lookups call argocd, Grafana, PostHog or git in every repo and can take tens of seconds: served
// stale-while-revalidate so none of them holds one of the window's 6 connections (see swr.ts).
route('GET', '/api/explore/usage', (_m, _r, _s, q) => swr(`usage:${q.get('repo')}:${q.get('id')}`, 30 * 60_000, () => exploreUsage(String(q.get('repo') ?? ''), String(q.get('id') ?? ''))))
route('GET', '/api/explore/summary', (_m, _r, _s, q) => exploreSummary(String(q.get('repo') ?? ''), String(q.get('id') ?? '')))
route('POST', '/api/explore/summary/warm', async (_m, req) => { const b = await body(req); return warmSummaries(String(b.repo ?? ''), Array.isArray(b.ids) ? b.ids.map(String) : []) })
route('GET', '/api/explore/repos', () => swr('repos', 60_000, () => listRepos(), { deadline: 3000 }))
route('GET', '/api/explore/connectors', (_m, _r, _s, q) => exploreConnectors(q.get('fresh') === '1'))
route('GET', '/api/explore/clickhouse', () => clickhouseDisks())
route('GET', '/api/explore/runtime', (_m, _r, _s, q) => swr(`runtime:${q.get('concept')}:${q.get('repos')}:${q.get('org')}`, 120_000, async () => {
  const repos = await Promise.all(String(q.get('repos') ?? '').split(',').filter(Boolean).map(r => checkRepo(r)))
  const charts = repos.find(r => existsSync(join(r, 'apps')) && /charts/.test(r)) ?? null
  return whereItRuns(String(q.get('concept') ?? ''), { repos, charts, org: q.get('org') })
}))
// Datastores and tiers: the ClickHouse clusters and tables that hold a concept's data, their size, disk and instance type.
route('GET', '/api/explore/data', (_m, _r, _s, q) => swr(`data:${q.get('concept')}:${q.get('repos')}`, 120_000, async () => {
  const repos = await Promise.all(String(q.get('repos') ?? '').split(',').filter(Boolean).map(r => checkRepo(r)))
  return exploreData(String(q.get('concept') ?? ''), repos)
}))
setTimeout(() => { if (!process.env.PERCH_NO_AGENT_SYNC) prewarmRuntime() }, 30_000).unref()
route('POST', '/api/explore/dream/save', async (_m, req) => { const b = await body(req); return saveDream(b as any) })
route('GET', '/api/pr/journey', (_m, _r, _s, q) => journey(String(q.get('url') ?? ''), q.get('fresh') === '1'))
route('POST', '/api/pr/queue', async (_m, req) => { const b = await body(req); return queuePr(String(b.pr ?? ''), b.on !== false) })
route('POST', '/api/prs/orchestrate', async (_m, req) => { const b = await body(req); const r = await orchestrate(b.prs ?? [], b.where === 'cloud' ? 'cloud' : 'here', b.goal ?? 'both'); broadcast('conversations'); return r })
route('POST', '/api/pr/fix-ci', async (_m, req) => { const b = await body(req); const r = await fixCi(String(b.pr ?? ''), b.where === 'here' ? 'here' : 'cloud', !!b.force); broadcast('conversations'); return r })
route('POST', '/api/pr/agent', async (_m, req) => {
  const b = await body(req)
  const r = await addAgent(String(b.pr ?? ''), b.agent, b.mode)
  if (r.ok) setTimeout(() => refreshPresence([String(b.pr)]), 4000) // show its avatar once it has started
  return r
})
route('GET', '/api/railyard', () => railyard())
route('GET', '/api/pr/workers', () => prWorkers())
route('GET', '/api/pr/agents', () => Object.fromEntries(presenceAll()))
route('GET', '/api/pr/presence/error', () => ({ error: presenceError() || null }))
route('POST', '/api/prs/section', async (_m, req) => { const b = await body(req); moveToSection(String(b.url), String(b.section), b.icon); return { ok: true } })
route('POST', '/api/prs/resort', async () => { resortSections(); return { ok: true } })
// Just enough to draw a PR link as a pill (title, state); cached 10 min since titles rarely change.
route('GET', '/api/origins', async (_m, _r, _s, q) => ({ status: originSyncStatus(), results: searchOrigins(q.get('q') ?? '', Number(q.get('limit')) || 50), chain: q.get('subject') ? originChain(q.get('subject')!) : undefined }))
// Title, state and author for a PR pill: batched, cached for an hour, perch's PR index when GitHub is out of reach.
route('GET', '/api/pr/brief', async (_m, _r, _s, q) => { const { prBrief } = await import('./ghpr.ts'); return prBrief(String(q.get('url') ?? ''), u => get<any>('select title, state, draft from prs where url = ?', u)) })
// A bare "#135188" in a reply: the one PR perch knows with that number (none or several: no link).
route('GET', '/api/pr/resolve', (_m, _r, _s, q) => { const n = Number(q.get('n')); if (!Number.isInteger(n) || n < 1) return { url: null }; const r = all<{ url: string }>('select url from prs where number = ? limit 2', n); return { url: r.length === 1 ? r[0].url : null } })
// Merged vs deployed for your PostHog PRs (the deploys board reads this).
route('GET', '/api/deploys', (_m, _r, _s, q) => listDeploys(Number(q.get('days') ?? 14)))
route('GET', '/api/pr/preview', (_m, _r, _s, q) => prPreview(String(q.get('url') ?? ''), PR_VIEW_MAX_AGE))
route('POST', '/api/pr/audit', async (_m, req) => { const r = await deepAudit(String((await body(req)).pr)); broadcast('conversations'); return r })
route('POST', '/api/enrich', async (_m, req) => enrich(String((await body(req)).url ?? '')))
route('GET', '/api/folders', () => ({ folders: folders(), organizer: organizerStatus }))
route('GET', '/api/folders/:id', m => folder(m[1]) ?? { error: 'not found' })
route('POST', '/api/folders', async (_m, req) => { const b = await body(req); return { id: saveFolder({ ...b, name: String(b.name ?? 'Folder') }) } })
route('DELETE', '/api/folders/:id', m => { deleteFolder(m[1]); return { ok: true } })
route('POST', '/api/folders/organize', async (_m, req) => organize(Boolean((await body(req)).full)))
// Everything "/" can complete: perch commands, installed skills, and the skill store.
route('GET', '/api/commands', async () => {
  const builtin = [
    { name: 'btw', description: 'Side question about this conversation; never saved into it', kind: 'perch' },
    { name: 'autoresearch', description: 'Improve one metric step by step in its own git worktree', kind: 'perch' },
    { name: 'research', description: 'Deep search across repos, Slack, meetings and upstream source, with parallel agents', kind: 'perch' },
  ]
  const local = localSkills().map(s => ({ name: s.name, description: s.description.slice(0, 160), kind: 'skill', where: s.where }))
  const have = new Set(local.map(s => s.name))
  let store: any[] = []
  if (skills.cached()) try { store = (await skills.list({ sort: 'name' })).results.filter((s: any) => !have.has(s.name)).map((s: any) => ({ name: s.name, description: String(s.description ?? '').slice(0, 160), kind: 'store', mine: s.mine })) } catch {}
  return { commands: [...builtin, ...local, ...store] }
})
route('GET', '/api/search/sources', () => ({ sources: SOURCES }))
route('GET', '/api/search/quick', async (_m, _r, _s, q) => ({ results: await quick(q.get('q') ?? '', q.get('sources')?.split(',').filter(Boolean), { agents: q.get('agents') === '1' }) }))
route('POST', '/api/insights/prs/summarize', async (_m, req) => { const r = await summarizePrs((await body(req)) as any); broadcast('conversations'); return r })
route('POST', '/api/search', async (_m, req) => { const b = await body(req); const r = startSearch({ q: String(b.q ?? ''), mode: b.mode, cwd: b.cwd }); broadcast('conversations'); return r })
route('POST', '/api/search/:id/steer', async (m, req) => { steerSearch(m[1], String((await body(req)).text ?? '')); return { ok: true } })
route('POST', '/api/search/:id/feedback', async (m, req) => { searchFeedback(m[1], (await body(req)).value); maybeLearn(); return { ok: true } })
route('GET', '/api/search/history', () => ({ runs: searchHistory(), stats: searchStats() }))
route('GET', '/api/search/playbook', () => ({ rules: all('select * from playbook order by status = \'retired\', created_at desc'), stats: searchStats() }))
route('POST', '/api/search/playbook', async (_m, req) => ({ id: addTactic(String((await body(req)).text ?? '')) }))
route('POST', '/api/search/playbook/:id', async (m, req) => { const b = await body(req); run('update playbook set status = ?, reason = ? where id = ?', b.status, b.status === 'retired' ? 'retired by you' : null, m[1]); return { ok: true } })
route('POST', '/api/search/learn', () => learnSearch())
route('POST', '/api/open-file', async (_m, req) => {
  if (!isLoopback(req)) return { error: 'opens apps on the Mac' }
  const b = await body(req)
  await openFile(String(b.path), b.line ? Number(b.line) : undefined)
  return { ok: true }
})
route('GET', '/api/autopilot', () => autopilotOverview())
// Evolve: your use cases, the skills perch made for them, and work agents dropped.
route('GET', '/api/evolve', () => evolveOverview())
route('POST', '/api/evolve/run', () => { evolveCycle(); return { ok: true } })
route('POST', '/api/evolve/usecase/:id/forge', async m => ({ skill: await forge(m[1]) }))
route('POST', '/api/evolve/usecase/:id/ignore', m => { ignoreUseCase(m[1]); return { ok: true } })
route('POST', '/api/evolve/skill/:id/retire', m => { retireSkill(m[1]); return { ok: true } })
route('POST', '/api/evolve/skill/:id/restore', m => { restoreSkill(m[1]); return { ok: true } })
route('POST', '/api/evolve/skill/:id/rollback', async (m, req) => { rollbackSkill(m[1], Number((await body(req)).version)); return { ok: true } })
// Pick dropped work back up: the agent checks where things stand and finishes, or says what blocks it.
route('POST', '/api/evolve/resume/:id', m => {
  const id = decodeURIComponent(m[1])
  send({ id, resume: true, manual: true, prompt: 'You stopped here before the work was finished. Check where things stand now (files, PRs, CI), then finish the task. If something blocks you, say exactly what and what you need from me.' })
  broadcast('conversations')
  return { ok: true }
})
route('POST', '/api/autopilot/scan', async () => ({ added: await autopilotScan() }))
route('POST', '/api/autopilot/:id/accept', async (m, req) => acceptSuggestion(m[1], await body(req)))
route('POST', '/api/autopilot/:id/dismiss', m => { dismissSuggestion(m[1]); return { ok: true } })
route('POST', '/api/autopilot/:id/later', m => { laterSuggestion(m[1]); return { ok: true } })
route('POST', '/api/autopilot/:id/undo', m => { undoSuggestion(m[1]); return { ok: true } })
route('POST', '/api/autopilot/:id/dryrun', (m, req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const stop = dryRunSuggestion(m[1], ev => { res.write(`data: ${JSON.stringify(ev)}\n\n`); if (ev.type === 'perch_done') res.end() })
  req.on('close', () => { if (!res.writableEnded) stop() })
  return undefined
})
route('POST', '/api/routines/:id/resume', m => { run('update routines set enabled = 1, paused_reason = null where id = ?', m[1]); review(m[1]); broadcast('autopilot'); return { ok: true } })
route('GET', '/api/routines', () => ({ routines: listRoutines(), webhookBase: `http://127.0.0.1:${PORT}/hooks/` }))
route('POST', '/api/routines', async (_m, req) => saveRoutine(await body(req)))
route('DELETE', '/api/routines/:id', m => { deleteRoutine(m[1]); return { ok: true } })
// Kits (docs/kits.md): import someone's skills, routines and CLAUDE.md snippet; preview first.
route('GET', '/api/kits', () => ({ kits: kits.installed() }))
route('POST', '/api/kits/preview', async (_m, req) => {
  const b = await body(req); const { values, paths } = await kits.myValues()
  let k; try { k = kits.openKit(String(b.src ?? '')) } catch (e: any) { return { error: e.message } } // a bad URL or folder is input, not a Health error
  try { return { manifest: k.manifest, items: kits.plan(k, values, paths) } } finally { k.cleanup() }
})
route('POST', '/api/kits/import', async (_m, req) => {
  const b = await body(req); const { values, paths } = await kits.myValues()
  let k; try { k = kits.openKit(String(b.src ?? '')) } catch (e: any) { return { error: e.message } }
  try { const items = kits.apply(k, values, paths, Array.isArray(b.only) ? b.only : undefined); broadcast('autopilot'); return { manifest: k.manifest, items } } finally { k.cleanup() }
})
route('DELETE', '/api/kits/:name', async m => { const { paths } = await kits.myValues(); const r = kits.remove(decodeURIComponent(m[1]), paths); broadcast('autopilot'); return r })
route('POST', '/api/routines/:id/run', m => {
  const r = listRoutines().find(x => x.id === m[1])
  return r ? { conversationId: fire(r, undefined, true) } : { error: 'not found' }
})

// Heartbeat for the app's watchdog: rewritten every 2s by this event loop, so its age says whether
// the server is making progress. Under heavy load a live server misses health checks; on 2026-11-16 the
// watchdog killed slow-but-working servers 9 times in 33 minutes (load 145-230), and each restart made
// the overload worse. The shell now restarts only when this goes stale too (shell/main.cjs).
{
  const beat = join(DATA_DIR, 'server.heartbeat')
  const tick = () => { try { writeFileSync(beat, `${process.pid} ${Date.now()}\n`) } catch {} }
  tick(); setInterval(tick, 2000).unref()
}

// Freezes leave a trace: when the event loop is blocked for over a second (every request and chat
// stream waits on it; past ~30s the shell restarts perch), say how long and what was last asked
// for, and log requests that took over 2s. server.log then names the cause instead of a vague "slow".
let lastRequest = ''
{
  let tick = performance.now()
  setInterval(() => {
    const now = performance.now(), late = now - tick - 250
    tick = now
    if (late > 1000) console.log(`[stall] event loop blocked ${Math.round(late)}ms (last request: ${lastRequest || 'none'})`)
    // Over a minute late is the Mac sleeping (timers don't run), not perch: say so, don't profile it.
    if (late > 60_000) recordAvailability('stall', late, 'mac asleep or auto-m8 suspended')
    else if (late > 2000) {
      const last = lastRequest || 'background work'
      explainStall(late).then(why => { recordAvailability('stall', late, last, why ?? ''); if (why) console.log(`[stall] ${Math.round(late)}ms was: ${why}`) }, () => recordAvailability('stall', late, last))
    }
  }, 250).unref()
}

// Each API request is a trace (latency.ts); long-lived streams aren't, they'd only add noise.
startLatency()
startTraceStore()
function handle(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '/').split('?')[0]
  if (!path.startsWith('/api/') || path === '/api/events' || path === '/api/latency' || path.startsWith('/api/traces')) return handleRequest(req, res)
  const t = startTrace(routeOf(req.method ?? 'GET', path))
  t.path = path
  const end = () => endTrace(t, res.statusCode)
  res.on('finish', end); res.on('close', end)
  return runInTrace(t, () => handleRequest(req, res))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const started = performance.now()
  lastRequest = `${req.method} ${url.pathname}`
  res.on('finish', () => { const ms = performance.now() - started; if (ms > 2000 && req.method === 'GET' && url.pathname !== '/api/events' && !url.pathname.startsWith('/ws/')) console.log(`[slow] ${req.method} ${url.pathname} took ${Math.round(ms)}ms`) })
  // Pairing: the one request an unpaired phone may make, with the one-time code from the QR.
  if (url.pathname === '/pair' && (settings.remote.enabled || settings.mobile.tailscale)) {
    const set = completePairing(url.searchParams.get('code') ?? '', req)
    if (!set) { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end(UNPAIRED_PAGE.replace("isn't paired", 'could not be paired: the code expired or was used')) }
    res.writeHead(302, { 'Set-Cookie': set, Location: '/#home' })
    broadcast('status')
    return res.end()
  }
  // Pairing and device management only from the Mac itself.
  if (url.pathname.startsWith('/api/remote') && !isLoopback(req)) return json(res, 403, { error: 'only from the Mac' })
  // Webhooks come from other local tools (or a tunnel), so they skip the Origin check and
  // authenticate with the routine's secret instead.
  const hook = url.pathname.match(/^\/hooks\/([\w-]+)$/)
  if (hook && req.method === 'POST') {
    const r = listRoutines().find(x => x.id === hook[1])
    const secret = req.headers['x-perch-secret'] ?? url.searchParams.get('secret')
    if (!r || !r.enabled || secret !== r.webhook_secret) return json(res, 404, { error: 'unknown hook' })
    try { return json(res, 200, { conversationId: fire(r, await body(req).catch(() => ({}))) }) } catch (e: any) { return json(res, 500, { error: e.message }) }
  }
  if (!allowed(req)) {
    if (!isLoopback(req) && !url.pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end(UNPAIRED_PAGE) }
    return json(res, 403, { error: 'forbidden' })
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res)
  for (const [method, re, h] of routes) {
    const m = req.method === method && url.pathname.match(re)
    if (!m) continue
    try {
      const out = await h(m, req, res, url.searchParams)
      if (out !== undefined) json(res, 200, out, req)
    } catch (e: any) {
      // One plain sentence for the user, and a record that perch can act on.
      const f = recordError(`${req.method} ${url.pathname.replace(/\/[0-9a-f-]{8,}|\/task:[^/]+/g, '/:id')}`, e)
      // A server that needs OAuth: start its sign-in now (the browser opens), the toast can reopen it.
      if (f.authorize) try { startMcpLogin(f.authorize) } catch {}
      if (!res.headersSent) json(res, 500, { error: f.message, action: f.action, retrying: f.status === 'retrying', authorize: f.authorize })
    }
    return
  }
  json(res, 404, { error: 'no route' })
}

// ---------- websockets: chat streams and terminals ----------
const wss = new WebSocketServer({ noServer: true })
function onUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  if (!allowed(req)) return socket.destroy()
  const url = new URL(req.url ?? '/', 'http://x')
  const chat = url.pathname.match(/^\/ws\/chat\/([\w-]+)$/)
  const term = url.pathname.match(/^\/ws\/term\/([\w-]+)$/)
  const browser = url.pathname.match(/^\/ws\/browser\/([\w:.-]+)$/)
  wss.handleUpgrade(req, socket, head, ws => {
    if (chat) {
      if (!chats.has(chat[1])) ws.send(JSON.stringify({ type: 'perch_state', state: 'exited' }))
      const unsub = subscribe(chat[1], ev => ws.send(JSON.stringify(ev)))
      ws.on('close', unsub)
    } else if (term) {
      const t = terms.get(term[1])
      if (!t) return ws.close(4404, 'no such terminal')
      ws.send(t.buf)
      const l = (d: string) => ws.send(d)
      t.listeners.add(l)
      ws.on('message', raw => {
        const m = JSON.parse(raw.toString())
        if (m.d && !typedInto(t, m.d)) t.p.write(m.d)
        if (m.r && !t.exited) t.p.resize(Math.max(2, m.r[0]), Math.max(2, m.r[1]))
      })
      ws.on('close', () => t.listeners.delete(l))
    } else if (browser) {
      browserSocket(decodeURIComponent(browser[1]), ws)
    } else ws.close()
  })
}

// The decision queue shows live: raised here, or by an agent through the MCP process (noticed by count).
onDecision.add(() => { broadcast('home'); broadcast('conversations') })
let decisionCount = ''
setInterval(() => { const n = `${openDecisions().length}:${autoDecided().length}`; if (n !== decisionCount) { if (decisionCount) { broadcast('home'); broadcast('conversations') } decisionCount = n } }, 5000).unref()
// Perch decides what's due: low-stakes ones right away, big ones once your window has passed.
setInterval(() => { try { decideDue() } catch (e) { console.error('decideDue', e) } }, 60_000).unref()
cleanListingLinks()
startIndexer()
expireBoards()
setInterval(() => { try { expireBoards() } catch (e) { console.error('expireBoards', e) } }, 60_000).unref()
startScheduler()
startRailyard()
startSpend()
startRace(broadcast, (id, prompt) => { send({ id, prompt, resume: true, by: 'automatic model race' }) })
startShadow(broadcast, () => runningChats().filter(c => c.state === 'running').length)
startAutopilot()
startEvolve()
startWishes()
startOrganizer()
resumeFollowers()
resumeHelpers()
startOrchestra()
// Lifecycle: stale chats get a closing pass (learnings to memory, a summary), then close.
const sweepLife = () => sweepLifecycle().then(() => broadcast('conversations')).catch(e => console.error('lifecycle', e))
setTimeout(sweepLife, 3 * 60_000).unref()
setInterval(sweepLife, 10 * 60_000).unref()
sweepWorktreesHourly()
// The judgement half of Needs me: every 10 minutes a small model reads where recent quiet conversations ended.
const sweepAttention = () => attentionSweep(list({ limit: 400, focus: false }).conversations as any).then(() => broadcast('conversations')).catch(e => console.error('attention', e))
setTimeout(sweepAttention, 90_000).unref()
setInterval(sweepAttention, 10 * 60_000).unref()
// Durable intervention tracking includes automation and cloud scouts, independently of UI filters.
const checkNeeds = () => sweepNeeds().then(() => broadcast('home')).catch(e => console.error('needs', e))
setTimeout(checkNeeds, 15_000).unref()
setInterval(checkNeeds, 60_000).unref()
// Merged PRs slow to reach production go to Needs me (an agent checks first); landed ones close themselves.
const checkDeploys = () => { if (isPaused()) return; checkSlowDeploys().then(n => { if (n) broadcast('home') }).catch(e => console.error('deploys', e?.message)) }
setTimeout(checkDeploys, 3 * 60_000).unref()
setInterval(checkDeploys, 15 * 60_000).unref()
// Stalled agents are nudged to carry on (twice a day at most) instead of landing in Needs me.
const sweepStalls = () => { if (isPaused()) return; try { const ids = resumeStalls(list({ states: ['active', 'idle', 'waiting'], limit: 400, focus: false }).conversations as any); if (ids.length) { console.log(`[stalls] resumed ${ids.length}`); broadcast('conversations') } } catch (e) { console.error('stalls', e) } }
setTimeout(sweepStalls, 2 * 60_000).unref()
setInterval(sweepStalls, 10 * 60_000).unref()
// Chats Claude never named get a short mission title from a small model.
const nameChats = () => isPaused() ? Promise.resolve() : sweepTitles().then(() => broadcast('conversations')).catch(e => console.error('titles', e))
setTimeout(nameChats, 60_000).unref()
setInterval(nameChats, 5 * 60_000).unref()
// The skill catalogue is kept warm so search never waits on it.
setTimeout(() => skills.warm(), 5000)
setInterval(() => skills.warm(), 9 * 60_000).unref()
// Rules run after every sync pass; the first brief of the day writes itself once data is in.
onTick.add(() => {
  if (applyRules()) broadcast('conversations')
  evaluatePlaybook()
  if (settings.ai.dailyBrief && !briefing && !get('select 1 from briefs where day = ?', today())) generateBrief().then(() => broadcast('home'))
})
refreshBasics().then(() => broadcast('status'))
refreshMcp().then(() => broadcast('status'))
const server = createServer(handle).on('upgrade', onUpgrade)
// Losing the port means another perch already serves this profile: leave at once. Living on
// (uncaughtException swallows it) runs a second set of shepherds, indexers and chat readers
// against the same db and FIFOs; 17 of those piled up on 2026-11-10.
server.on('error', e => { console.error('auto-m8: cannot listen, exiting', e); process.exit(1) })
server.listen(PORT, '127.0.0.1', () => { console.log(`auto-m8 on http://127.0.0.1:${PORT}`); ensureProductBoard().catch(e => console.error('product research board', e)); noteBoot(performance.now(), `modules ${Math.round(importsMs)}ms, then startup ${Math.round(performance.now() - importsMs)}ms`) })

// Phone access: one extra listener per LAN address (never 0.0.0.0), re-checked as networks
// change. Every request on these still needs a paired device.
const lan = new Map<string, ReturnType<typeof createServer>>()
function syncLan() {
  const want = new Set(settings.remote.enabled ? lanHosts(PORT).ips : [])
  for (const [ip, srv] of lan) if (!want.has(ip)) { srv.close(); lan.delete(ip) }
  for (const ip of want) {
    if (lan.has(ip)) continue
    const srv = createServer(handle).on('upgrade', onUpgrade)
    srv.on('error', e => { console.error('[lan]', ip, e.message); lan.delete(ip) })
    srv.listen(PORT, ip, () => console.log(`auto-m8 for paired phones on http://${ip}:${PORT}`))
    lan.set(ip, srv)
  }
}
syncLan()
setInterval(syncLan, 30_000).unref()

// Phone access from anywhere: tailscale serve (https on the tailnet) proxies to this listener.
// Bound to 127.0.0.1, but marked so nothing on it counts as the Mac: every request needs pairing.
let tailnet: ReturnType<typeof createServer> | null = null
function syncTailnet() {
  const want = settings.mobile.tailscale
  if (!want && tailnet) { tailnet.close(); tailnet = null }
  if (want && !tailnet) {
    setRemoteOnlyPort(remotePort())
    tailnet = createServer(handle).on('upgrade', onUpgrade)
    tailnet.on('error', e => { console.error('[tailnet]', e.message); tailnet = null })
    tailnet.listen(remotePort(), '127.0.0.1', () => console.log(`auto-m8 for the tailnet on 127.0.0.1:${remotePort()} (${tailscaleUrl() ?? 'serve not set up'})`))
  }
}
setRemoteOnlyPort(remotePort())
refreshTailscale().then(syncTailnet).catch(() => {})
setInterval(() => refreshTailscale().catch(() => {}), 5 * 60_000).unref()
// Push what needs you while you're away; keep the Mac awake while agents run.
setInterval(() => { notifyTick().catch(e => console.error('[push]', e?.message)) }, 20_000).unref()
setInterval(() => { cloud.tick().then(() => broadcast('conversations')).catch(e => console.error('[cloud]', e?.message)) }, 60_000).unref()
setInterval(stayAwakeTick, 15_000).unref()
// Codex and Cursor get the same instructions, memory, skills and MCP servers as Claude Code
// (agentsync.ts), so either can pick up a chat when Claude is at its cap.
const agentSync = () => { const r = syncAgents({ command: existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath, args: [join(import.meta.dirname, 'mcp.ts')] }); if (Object.values(r).some(v => Array.isArray(v) ? v.length : v === 'updated' || typeof v === 'number' && v > 0 || 'error' in r)) console.log('[agentsync]', JSON.stringify(r)) }
// A second instance (a dev or test server on another port) must not rewrite the live app's Codex/Cursor config.
if (!process.env.PERCH_NO_AGENT_SYNC) { agentSync(); setInterval(agentSync, 60 * 60_000).unref() }
