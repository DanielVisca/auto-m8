// What the product overlay knows about a page and its elements, decision-ready: counted by the
// customer unit (organizations when the project has that group type, else people), compared with the
// same window a week earlier, optionally narrowed to teams new to the page (the rollout view), ranked
// into a "needs attention" list, with the replays and power users worth opening.
//
// Window: the last 24 hours, rolling (no jump at midnight). Badges, panel and cards all use it, so they
// agree. "Last week" = the same span
// shifted back 7 days, which keeps weekday effects out of the comparison.

export const START = `now() - INTERVAL 24 HOUR`
export const CUR = `timestamp >= ${START}`
const BOTH = `timestamp >= ${START} - INTERVAL 7 DAY AND (timestamp >= ${START} OR timestamp < now() - INTERVAL 7 DAY)`
const PATH = `match(properties.$pathname, {path})`
export const PAGE_FILTER = `${CUR} AND ${PATH}`

export type Cohort = 'all' | 'new'
export type Unit = { index: number | null; label: string; singular: string }
type Q = (query: string, values?: Record<string, any>) => Promise<any[][]>

// The column that identifies a customer: $group_N for organizations/companies, else the person.
export const orgOf = (u: Unit) => u.index != null ? `$group_${u.index}` : `toString(person_id)`
// Teams whose first visit to this page in 30 days was within the last 7: newly rolled out to.
export function cohortSql(u: Unit, c: Cohort) {
  if (c !== 'new') return ''
  const o = orgOf(u)
  return ` AND ${o} IN (SELECT ${o} FROM events WHERE event = '$pageview' AND ${PATH} AND timestamp >= now() - INTERVAL 30 DAY AND ${o} != '' GROUP BY ${o} HAVING min(timestamp) >= now() - INTERVAL 7 DAY)`
}

const NOISE = /AbortError|Canceled|cancell?ed|new query started|signal is aborted|ResizeObserver|Load failed|Network request failed|NetworkError/i
export const isNoise = (type: string, value: string) => NOISE.test(`${type} ${value}`)

// ---------- describing and locating a spot from its element chain ----------
// 'button.LemonButton.LemonButton--has-icon…' + scope → 'icon button in logs-table › logs-viewer'
export function describeLeaf(leaf: string, text?: string | null, scope?: string | null, parent = '') {
  if (/^(button|a)\b/.test(parent) && (/^(span|svg|path|i)\b/.test(leaf) || leaf.includes('__chrome'))) leaf = parent
  const [tag, ...cls] = leaf.split('.')
  const icon = cls.some(c => /no-content|has-icon|icon/i.test(c)) && !text
  const named = cls.find(c => /^[A-Z]/.test(c) && !c.includes('--'))
  const what = text ? `${tag} "${String(text).slice(0, 30)}"` : icon ? `icon ${tag}` : named ? `${tag}.${named}` : tag || 'element'
  return scope ? `${what} in ${scope}` : what
}
// What the page needs to find that spot again: tag, a distinctive class, text, nearest data-attr.
export function locateFor(leaf: string, text?: string | null, scope?: string | null, parent = '') {
  if (/^(button|a)\b/.test(parent) && (/^(span|svg|path|i)\b/.test(leaf) || leaf.includes('__chrome'))) leaf = parent
  const [tag, ...cls] = leaf.split('.')
  const stable = cls.filter(c => c && !/[:\[\]@\/]/.test(c))
  return { tag: tag || '*', cls: stable.filter(c => !c.includes('--')).sort((a, b) => (/^[A-Z]/.test(b) ? 1 : 0) - (/^[A-Z]/.test(a) ? 1 : 0)).slice(0, 2), mods: stable.filter(c => c.includes('--')).slice(0, 3), text: text || undefined, scope: String(scope ?? '').split(' › ')[0] || undefined }
}

// The same spot shows up as several chains (state classes like --active differ): merge by description.
// Teams are summed per chain, so a team that hit two variants counts twice: an upper bound.
export function mergeFriction(rows: any[][]) {
  // [leaf, parent, text, scope, rage, dead, orgs, prevOrgs, latest session id]
  const by = new Map<string, { what: string; rage: number; dead: number; orgs: number; prevOrgs: number; locate: any; sid?: string; leaves: string[] }>()
  for (const r of rows) {
    const what = describeLeaf(String(r[0] ?? ''), r[2], r[3], String(r[1] ?? ''))
    const m = by.get(what) ?? { what, rage: 0, dead: 0, orgs: 0, prevOrgs: 0, locate: locateFor(String(r[0] ?? ''), r[2], r[3], String(r[1] ?? '')), leaves: [] as string[] }
    if (r[0] && !m.leaves.includes(String(r[0]))) m.leaves.push(String(r[0]))
    m.rage += r[4] ?? 0; m.dead += r[5] ?? 0; m.orgs += r[6] ?? 0; m.prevOrgs += r[7] ?? 0
    if (!m.sid && r[8]) m.sid = r[8]
    by.set(what, m)
  }
  return [...by.values()].filter(m => m.rage + m.dead > 0).sort((a, b) => b.orgs - a.orgs || b.rage + b.dead - (a.rage + a.dead))
}

// ---------- needs attention ----------
export type Attention = { source?: string; kind: 'error' | 'friction' | 'latency'; title: string; detail: string; orgs: number; prevOrgs: number; isNew: boolean; score: number; noise?: boolean; locate?: any; replay?: string; short?: string }
// teams affected × how bad × whether it's new or growing since last week
export function rankAttention(items: Omit<Attention, 'score' | 'isNew'>[], limit = 5): Attention[] {
  const sev = { error: 3, latency: 2, friction: 1.5 }
  return items.map(i => {
    const isNew = i.prevOrgs === 0 && i.orgs > 0
    // brand new beats merely growing (capped at 3×), which beats steady (1×) and shrinking (down to 0.5×)
    const trend = isNew ? 4 : Math.min(3, Math.max(0.5, i.orgs / Math.max(1, i.prevOrgs)))
    return { ...i, isNew, score: i.orgs * sev[i.kind] * trend * (i.noise ? 0.15 : 1) }
  }).filter(i => i.orgs > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

// ---------- the page ----------
// Progressive: emit(partial) after every query lands, so the panel and pins fill in as results
// arrive (headline first, ~4s) instead of after the slowest one. `loading` says what's still coming.
export async function pageSummary(q: Q, project: number, base: string, path: string, u: Unit, c: Cohort, emit?: (partial: any) => void) {
  // One failed section shouldn't blank the panel: each query falls back to no rows, and the panel
  // says which parts are missing.
  const missing: string[] = []
  const q0 = q
  q = (query, values) => q0(query, values).catch((e: any) => { missing.push(String(e.message).slice(0, 120)); return [] })
  const v = { path }, o = orgOf(u), C = cohortSql(u, c)
  const isCur = `timestamp >= ${START}`
  const chainParts = `splitByChar(':', splitByChar(';', elements_chain)[1])[1] leaf, splitByChar(':', splitByChar(';', elements_chain)[2])[1] parent, elements_chain_texts[1] txt,
        arrayStringConcat(arraySlice(extractAll(elements_chain, 'attr__data-attr="([^"]+)"'), 1, 2), ' › ') scope`
  const pv = `event = '$pageview'`, ex = `event = '$exception'`, wv = `event = '$web_vitals'`, qa = `event = 'query api response'`
  const replay = (sid: any) => sid ? `${base}/project/${project}/replay/${sid}` : undefined
  const sqlFor = (sql: string, extra: Record<string, any> = {}) => sqlUrl(base, project, inlineSql(sql, { ...v, ...extra }))
  const profile = (k: string) => `${base}/project/${project}/groups/${u.index}/${encodeURIComponent(k)}`
  const r: Record<string, any[][] | null> = { page: null, errors: null, frustration: null, slowTypes: null, where: null, powerOrgs: null, powerPeople: null, orgNames: null, emails: null }

  const build = (final: boolean) => {
    const P = r.page?.[0] ?? []
    const errs = (r.errors ?? []).map(x => ({ type: x[0] ?? 'Error', value: x[1] ?? '', count: x[2], orgs: x[3], prevOrgs: x[4], users: x[5], replay: replay(x[6]), noise: isNoise(x[0] ?? '', x[1] ?? '') }))
    const where = r.where ?? []
    const whereOf = (e: any) => { const w = where.find(w => w[0] === e.type && w[1] === e.value); return w ? { what: describeLeaf(String(w[2] ?? ''), w[4], w[5], String(w[3] ?? '')), locate: locateFor(String(w[2] ?? ''), w[4], w[5], String(w[3] ?? '')) } : null }
    const friction = mergeFriction(r.frustration ?? [])
    const slow = (r.slowTypes ?? []).filter(x => x[3] > 0).map(x => ({ type: x[0] ?? 'query', p95: x[1], prev95: x[2], orgs: x[3], prevOrgs: x[4] }))
    const attention = rankAttention([
      ...errs.map(e => { const w = whereOf(e); return { source: sqlFor(`SELECT properties.$exception_types[1] AS type, properties.$exception_values[1] AS value, count() AS n, uniqIf(${o}, ${o} != '') AS ${u.label.replace(/\W/g, '_')}, uniq(person_id) AS people, groupUniqArray(5)($session_id) AS sessions\nFROM events\nWHERE event = '$exception' AND ${PAGE_FILTER}${C}\n  AND properties.$exception_types[1] = {et} AND substring(toString(properties.$exception_values[1]), 1, 120) = {ev}\nGROUP BY type, value`, { et: e.type, ev: e.value }), kind: 'error' as const, title: `${e.type}${e.value ? ': ' + e.value : ''}`, detail: `${e.count}× · ${e.orgs} ${u.label}${w ? ` · after a click on ${w.what}` : ''}`, orgs: e.orgs, prevOrgs: e.prevOrgs, noise: e.noise, locate: w?.locate, replay: e.replay, short: `⚠ ${e.count} ${e.type} · ${e.orgs} ${u.label}` } }),
      ...friction.map(f => ({ source: sqlFor(`SELECT event, count() AS n, uniqIf(${o}, ${o} != '') AS ${u.label.replace(/\W/g, '_')}, uniq(person_id) AS people, any(elements_chain) AS example_chain\nFROM events\nWHERE event IN ('$rageclick', '$dead_click') AND ${PAGE_FILTER}${C}\n  AND splitByChar(':', splitByChar(';', elements_chain)[1])[1] IN {leaves}\nGROUP BY event`, { leaves: f.leaves }), kind: 'friction' as const, title: `${f.rage + f.dead} rage/dead clicks on ${f.what}`, detail: `${f.rage} rage · ${f.dead} dead · ${f.orgs} ${u.label}`, orgs: f.orgs, prevOrgs: f.prevOrgs, locate: f.locate, replay: replay(f.sid), short: `${f.rage + f.dead} rage/dead · ${f.orgs} ${u.label}` })),
      ...slow.map(x => ({ kind: 'latency' as const, title: `${x.type} p95 ${Math.round(x.p95)}ms`, detail: `${x.orgs} ${u.label} waited over 3s${x.prev95 ? ` · p95 a week ago ${Math.round(x.prev95)}ms` : ''}`, orgs: x.orgs, prevOrgs: x.prevOrgs })),
    ])
    const orgName = new Map((r.orgNames ?? []).map(x => [String(x[0]), x])), email = new Map((r.emails ?? []).map(x => [String(x[0]), x]))
    return {
      cohort: c, unit: u.label, missing: [...new Set(missing)], partial: !final,
      source: sqlFor(`SELECT uniqIf(person_id, event = '$pageview') AS people, uniqIf(${o}, event = '$pageview' AND ${o} != '') AS ${u.label.replace(/\W/g, '_')}, countIf(event = '$pageview') AS pageviews, countIf(event = '$exception') AS errors\nFROM events\nWHERE event IN ('$pageview', '$exception') AND ${PAGE_FILTER}${C}`),
      loading: final ? null : { headline: !r.page, errors: !r.errors, friction: !r.frustration, latency: !r.slowTypes, where: !r.where, power: !r.powerPeople },
      people: P[0] ?? 0, orgs: P[1] ?? 0, pageviews: P[2] ?? 0, prevOrgs: P[3] ?? 0,
      errors: errs.slice(0, 6), errorTotal: P[4] ?? 0, errorOrgs: P[5] ?? 0, prevErrorTotal: P[6] ?? 0,
      vitals: P[9] ? { lcp: P[7], inp: P[8] } : null,
      // PostHog's own app reports each API query's time; most products don't, and this stays empty.
      queries: P[10] ? { count: P[10], p50: P[11], p95: P[12], prev95: P[13] } : null,
      friction: friction.slice(0, 4),
      attention,
      power: {
        orgs: (r.powerOrgs ?? []).map(x => ({ key: x[0], name: orgName.get(String(x[0]))?.[1] || String(x[0]).slice(0, 8), mrr: orgName.get(String(x[0]))?.[2], events: x[1], people: x[2], url: profile(String(x[0])) })),
        people: (r.powerPeople ?? []).map(x => ({ id: x[0], email: email.get(String(x[0]))?.[1] || email.get(String(x[0]))?.[2] || String(x[1]).slice(0, 12), events: x[2], url: `${base}/project/${project}/person/${encodeURIComponent(String(x[1]))}` })),
      },
    }
  }
  const got = (k: string) => (rows: any[][]) => { r[k] = rows; emit?.(build(false)); return rows }

  await Promise.all([
    // One scan for the page's headline numbers (views, exceptions, web vitals, API query times).
    q(`SELECT uniqIf(person_id, ${pv} AND ${isCur}), uniqIf(${o}, ${pv} AND ${isCur} AND ${o} != ''), countIf(${pv} AND ${isCur}), uniqIf(${o}, ${pv} AND NOT ${isCur} AND ${o} != ''),
         countIf(${ex} AND ${isCur}), uniqIf(${o}, ${ex} AND ${isCur} AND ${o} != ''), countIf(${ex} AND NOT ${isCur}),
         quantileIf(0.75)(toFloat(properties.$web_vitals_LCP_value), ${wv} AND ${isCur}), quantileIf(0.75)(toFloat(properties.$web_vitals_INP_value), ${wv} AND ${isCur}), countIf(${wv} AND ${isCur}),
         countIf(${qa} AND ${isCur}), quantileIf(0.5)(toFloat(properties.total_time_ms), ${qa} AND ${isCur}), quantileIf(0.95)(toFloat(properties.total_time_ms), ${qa} AND ${isCur}), quantileIf(0.95)(toFloat(properties.total_time_ms), ${qa} AND NOT ${isCur})
       FROM events WHERE event IN ('$pageview', '$exception', '$web_vitals', 'query api response') AND ${PATH} AND ${BOTH}${C}`, v).then(got('page')),
    q(`SELECT properties.$exception_types[1] t, substring(toString(properties.$exception_values[1]), 1, 120) val,
         countIf(${isCur}) n, uniqIf(${o}, ${isCur} AND ${o} != '') orgs, uniqIf(${o}, NOT ${isCur} AND ${o} != '') prev, uniqIf(person_id, ${isCur}) ppl,
         argMaxIf($session_id, timestamp, ${isCur} AND $session_id != '') sid
       FROM events WHERE event = '$exception' AND ${PATH} AND ${BOTH}${C} GROUP BY t, val HAVING n > 0 ORDER BY orgs DESC, n DESC LIMIT 10`, v).then(got('errors'))
      .then(errors => {
        // Where the top real errors happen: the element most often clicked in the 10s before them.
        const real = errors.map(x => ({ type: x[0] ?? 'Error', value: x[1] ?? '' })).filter(e => !isNoise(e.type, e.value)).slice(0, 3)
        if (!real.length) return got('where')([])
        return q(`SELECT e.properties.$exception_types[1] t, substring(toString(e.properties.$exception_values[1]), 1, 120) val, c.leaf, c.parent, c.txt, c.scope, count() n
            FROM events e INNER JOIN (SELECT $session_id sid, timestamp ts, ${chainParts} FROM events WHERE event = '$autocapture' AND ${PAGE_FILTER}${C}) c ON e.$session_id = c.sid
            WHERE e.event = '$exception' AND e.timestamp >= ${START} AND e.timestamp >= c.ts AND e.timestamp <= c.ts + INTERVAL 10 SECOND AND ${real.map((_, i) => `(e.properties.$exception_types[1] = {t${i}} AND substring(toString(e.properties.$exception_values[1]), 1, 120) = {v${i}})`).join(' OR ')}
            GROUP BY t, val, c.leaf, c.parent, c.txt, c.scope ORDER BY n DESC LIMIT 30`,
          { ...v, ...Object.fromEntries(real.flatMap((e, i) => [[`t${i}`, e.type], [`v${i}`, e.value]])) }).then(got('where'))
      }),
    q(`SELECT ${chainParts}, countIf(event = '$rageclick' AND ${isCur}) rage, countIf(event = '$dead_click' AND ${isCur}) dead,
         uniqIf(${o}, ${isCur} AND ${o} != '') orgs, uniqIf(${o}, NOT ${isCur} AND ${o} != '') prev,
         argMaxIf($session_id, timestamp, ${isCur} AND $session_id != '') sid
       FROM events WHERE event IN ('$rageclick', '$dead_click') AND ${PATH} AND ${BOTH}${C}
       GROUP BY leaf, parent, txt, scope ORDER BY orgs DESC, rage + dead DESC LIMIT 60`, v).then(got('frustration')),
    // Slow query types: the teams that waited over 3s, now and a week ago.
    q(`SELECT properties.query_type qt, quantileIf(0.95)(toFloat(properties.total_time_ms), ${isCur}) p95, quantileIf(0.95)(toFloat(properties.total_time_ms), NOT ${isCur}) prev95,
         uniqIf(${o}, ${isCur} AND toFloat(properties.total_time_ms) > 3000 AND ${o} != '') orgs, uniqIf(${o}, NOT ${isCur} AND toFloat(properties.total_time_ms) > 3000 AND ${o} != '') prev
       FROM events WHERE event = 'query api response' AND ${PATH} AND ${BOTH}${C} GROUP BY qt HAVING countIf(${isCur}) >= 20 ORDER BY orgs DESC LIMIT 6`, v).then(got('slowTypes')),
    // Power users: page views and clicks only (every event on the page is a 60s scan), names looked up after.
    Promise.all([
      u.index != null ? q(`SELECT ${o} k, count() n, uniq(person_id) ppl FROM events WHERE event IN ('$pageview', '$autocapture') AND ${PAGE_FILTER} AND ${o} != ''${C}
         GROUP BY k ORDER BY n DESC LIMIT 5`, v) : Promise.resolve([] as any[][]),
      q(`SELECT person_id, any(distinct_id), count() n, any(coalesce(nullIf(toString(person.properties.email), ''), distinct_id)) FROM events WHERE event IN ('$pageview', '$autocapture') AND ${PAGE_FILTER}${C}
         GROUP BY person_id ORDER BY n DESC LIMIT 5`, v),
    ]).then(([orgs, people]) => {
      r.powerOrgs = orgs; got('powerPeople')(people)
      return Promise.all([
        orgs.length ? q(`SELECT key, properties.name, properties.mrr FROM groups WHERE index = ${u.index} AND key IN {keys}`, { keys: orgs.map(x => String(x[0])) }) : Promise.resolve([] as any[][]),
        // emails come with the person query (person properties are on the events): no slow persons lookup
        Promise.resolve(people.map(x => [x[0], x[3]]) as any[][]),
      ]).then(([names, emails]) => { r.orgNames = names; got('emails')(emails) })
    }),
  ])
  return build(true)
}

// ---------- what a click was on: one identity per control ----------
// posthog-js records the exact element clicked, so one button shows up as many chains (its icon, its
// label, its --active state, its nth-child). Normalise each click to the control that was clicked (the
// first a/button/input/... within the leaf's first 3 elements) and identify it by tag, text, data-attr,
// nearest data-attr above it, id, aria-label, href and BEM class. The badges and the card both count
// with exactly these expressions, so they always agree, and the SQL the card links to is the same.
const ELS = `splitByChar(';', elements_chain)`
const CI = `arrayFirstIndex(x -> match(x, '^(a|button|input|select|textarea|summary|label)[.:]'), arraySlice(${ELS}, 1, 3))`
const NLEAF = `if(${CI} > 0, ${ELS}[${CI}], ${ELS}[1])`
export const N = {
  tag: `extract(${NLEAF}, '^([a-z0-9-]+)')`,
  text: `extract(arrayStringConcat(arraySlice(${ELS}, 1, greatest(${CI}, 1)), ';'), 'text="([^"]*)"')`,
  attr: `extract(${NLEAF}, 'attr__data-attr="([^"]*)"')`,
  scope: `extract(arrayStringConcat(arraySlice(${ELS}, greatest(${CI}, 1) + 1, 40), ';'), 'attr__data-attr="([^"]*)"')`,
  id: `extract(${NLEAF}, 'attr_id="([^"]*)"')`,
  aria: `extract(${NLEAF}, 'attr__aria-label="([^"]*)"')`,
  href: `extract(${NLEAF}, 'href="([^"]*)"')`,
  bem: `extract(${NLEAF}, '^[a-z0-9-]+[^:]*?[.]([A-Za-z][A-Za-z0-9-]*__[A-Za-z0-9_-]+)')`,
  pbem: `if(${NLEAF} LIKE 'input%' OR ${NLEAF} LIKE 'textarea%' OR ${NLEAF} LIKE 'select%', extract(${ELS}[greatest(${CI}, 1) + 1], '^[a-z0-9-]+[^:]*?[.]([A-Za-z][A-Za-z0-9]*__[a-z0-9]+(?:-[a-z0-9]+)*)'), '')`,
}
const KEYS = ['tag', 'text', 'attr', 'scope', 'id', 'aria', 'href', 'bem', 'pbem'] as const
export type Norm = Record<(typeof KEYS)[number], string>
const CLICKISH = `event IN ('$autocapture', '$rageclick', '$dead_click') AND (event != '$autocapture' OR properties.$event_type = 'click')`

// The WHERE for one control: cheap LIKEs on the raw chain first, then the exact identity. Every LIKE
// matches the same string the exact values are extracted from, so it only skips rows that can't match:
// the counts stay exact (unlike elements_chain_texts, which trims text differently and dropped clicks).
export function normFilter(n: Partial<Norm>, x = '') {
  const values: Record<string, any> = {}, pre: string[] = [], exact: string[] = []
  for (const k of KEYS) { values[`n${x}_${k}`] = n[k] ?? ''; exact.push(`${N[k]} = {n${x}_${k}}`) }
  if (n.text) { pre.push(`elements_chain LIKE {p${x}_text}`); values[`p${x}_text`] = `%text="${likeEsc(n.text)}"%` }
  if (n.attr) { pre.push(`elements_chain LIKE {p${x}_attr}`); values[`p${x}_attr`] = `%attr__data-attr="${n.attr}"%` }
  if (n.id) { pre.push(`elements_chain LIKE {p${x}_id}`); values[`p${x}_id`] = `%attr_id="${n.id}"%` }
  if (n.bem) { pre.push(`elements_chain LIKE {p${x}_bem}`); values[`p${x}_bem`] = `%${n.bem}%` }
  if (n.aria) { pre.push(`elements_chain LIKE {p${x}_aria}`); values[`p${x}_aria`] = `%attr__aria-label="${n.aria}"%` }
  if (n.scope) { pre.push(`elements_chain LIKE {p${x}_scope}`); values[`p${x}_scope`] = `%attr__data-attr="${n.scope}"%` }
  return { sql: [...pre, ...exact].join(' AND '), pre: '', values }
}
const likeEsc = (t: string) => t.replace(/[\\%_]/g, c => '\\' + c)
// One badge can stand for several identities (the button, and its label recorded without the button's
// attributes): the card counts all of them, so its numbers are the badge's numbers.
export function normFilterAny(ns: Partial<Norm>[]) {
  if (ns.length === 1) return normFilter(ns[0])
  const fs = ns.map((n, i) => normFilter(n, String(i)))
  return { sql: `(${fs.map(f => `(${f.sql})`).join(' OR ')})`, pre: fs.every(f => f.pre) ? `(${fs.map(f => `(${f.pre})`).join(' OR ')})` : '', values: Object.assign({}, ...fs.map(f => f.values)) }
}

// Every control clicked on this page with its counts: the badges. Two passes so badges appear fast:
// counts: group by raw chain first, then normalise only the distinct chains (sums stay exact);
// people: distinct people and customers per control need every event, so they come second.
export async function elementRows(q: Q, path: string, u: Unit, c: Cohort, pass: 'counts' | 'people') {
  const o = orgOf(u), norm = KEYS.map(k => `${N[k]} AS n${k}`).join(', '), group = KEYS.map(k => `n${k}`).join(', ')
  const asNorm = (r: any[]) => Object.fromEntries(KEYS.map((k, i) => [k, r[i] ?? ''])) as Norm
  if (pass === 'counts') {
    // Per control, its hourly clicks too (the card's chart draws from this at once): group by raw chain
    // and hour, normalise each distinct pair, then roll up.
    const rows = await q(`SELECT ${group}, sum(c) cs, sum(r) rs, sum(d) ds, groupArray((h, c + r + d)) hours FROM (
        SELECT ${group}, h, sum(clicks) c, sum(rage) r, sum(dead) d FROM (
          SELECT ${norm}, h, clicks, rage, dead FROM (
            SELECT elements_chain, toUnixTimestamp(toStartOfHour(timestamp)) h, countIf(event = '$autocapture') clicks, countIf(event = '$rageclick') rage, countIf(event = '$dead_click') dead
            FROM events WHERE ${CLICKISH} AND ${PAGE_FILTER}${cohortSql(u, c)} GROUP BY elements_chain, h))
        GROUP BY ${group}, h)
      GROUP BY ${group} ORDER BY cs + rs + ds DESC LIMIT 2000`, { path })
    return rows.map(r => ({ norm: asNorm(r), clicks: r[9], rage: r[10], dead: r[11], people: 0, orgs: 0, hours: (r[12] ?? []).map((x: any) => [Number(x[0]), Number(x[1])]) as [number, number][] }))
  }
  // Per control, who uses it most too (the card's "uses it most" draws from this at once).
  const rows = await q(`SELECT ${group}, uniq(person_id) ppl, uniqIf(org, org != '') orgs, topK(3)(nullIf(org, '')) torgs, topK(3)((who, did)) tppl FROM (
      SELECT person_id, distinct_id AS did, coalesce(nullIf(toString(person.properties.email), ''), distinct_id) AS who, ${o} AS org, ${norm} FROM events WHERE ${CLICKISH} AND ${PAGE_FILTER}${cohortSql(u, c)})
    GROUP BY ${group} ORDER BY ppl DESC LIMIT 2000`, { path })
  return rows.map(r => ({ norm: asNorm(r), clicks: 0, rage: 0, dead: 0, people: r[9], orgs: r[10], topOrgs: (r[11] ?? []).map(String), topPeople: (r[12] ?? []).map((t: any) => ({ who: String(t[0]), did: String(t[1]) })) }))
}
// Names for the top organizations across all badges, in one lookup.
export async function orgNames(q: Q, u: Unit, keys: string[]) {
  if (u.index == null || !keys.length) return new Map<string, string>()
  // explicit LIMIT: the query API returns only 100 rows by default. Chunks of 1000 keys, in parallel.
  const chunks = Array.from({ length: Math.ceil(keys.length / 1000) }, (_, i) => keys.slice(i * 1000, i * 1000 + 1000))
  const rows = (await Promise.all(chunks.map(k => q(`SELECT key, properties.name FROM groups WHERE index = ${u.index} AND key IN {keys} LIMIT 2000`, { keys: k }).catch(() => [] as any[][])))).flat()
  return new Map(rows.map(r => [String(r[0]), String(r[1] ?? '')]))
}

// HogQL with its placeholders filled in, for "open this query in PostHog".
export function inlineSql(sql: string, values: Record<string, any>) {
  const lit = (v: any): string => Array.isArray(v) ? `[${v.map(lit).join(', ')}]` : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return sql.replace(/\{(\w+)\}/g, (m, k) => k in values ? lit(values[k]) : m).replace(/[ \t]*\n[ \t]*/g, '\n  ')
}
// The logs page filtered to these backend request ids (their request_started/finished lines carry
// request_id, trace_id, team and user): click -> frontend request -> backend logs.
export function logsUrl(base: string, project: number, requestIds: string[], from = '-2d') {
  const filterGroup = { type: 'AND', values: [{ type: 'AND', values: [{ key: 'request_id', type: 'log_attribute', operator: 'exact', value: requestIds }] }] }
  return `${base}/project/${project}/logs?dateRange=${encodeURIComponent(JSON.stringify({ date_from: from, date_to: null }))}&filterGroup=${encodeURIComponent(JSON.stringify(filterGroup))}`
}
export const sqlUrl = (base: string, project: number, sql: string) => `${base}/project/${project}/sql?open_query=${encodeURIComponent(sql)}`
// The same count as a trends insight, filters laid out (approximate: insights can't normalise chains).
export function insightUrl(base: string, project: number, path: string, n: Partial<Norm>) {
  const props: any[] = [{ type: 'event', key: '$pathname', operator: 'regex', value: path }, { type: 'event', key: '$event_type', operator: 'exact', value: ['click'] }]
  if (n.text) props.push({ type: 'element', key: 'text', operator: 'exact', value: [n.text] })
  if (n.attr) props.push({ type: 'element', key: 'selector', operator: 'exact', value: [`[data-attr="${n.attr}"]`] })
  else if (n.scope) props.push({ type: 'element', key: 'selector', operator: 'exact', value: [`[data-attr="${n.scope}"] ${n.tag || ''}`.trim()] })
  if (n.href) props.push({ type: 'element', key: 'href', operator: 'exact', value: [n.href] })
  const query = { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', interval: 'hour', dateRange: { date_from: '-1d' },
    series: [{ kind: 'EventsNode', event: '$autocapture', name: 'clicks', math: 'total', properties: props }, { kind: 'EventsNode', event: '$autocapture', name: 'people', math: 'dau', properties: props }] } }
  return `${base}/project/${project}/insights/new#q=${encodeURIComponent(JSON.stringify(query))}`
}

// ---------- one element ----------
// Progressive like pageSummary: emit(partial) after each query lands, so the card shows usage in a
// few seconds and fills in errors, backend, replays and top users as they arrive. `loading` lists
// what's still coming; the slow whole-site count is started last.
export async function elementInsights(q: Q, project: number, base: string, path: string, u: Unit, c: Cohort, filter: { sql: string; values: Record<string, any>; pre?: string }, norm?: Partial<Norm>, emit?: (partial: any) => void) {
  const o = orgOf(u), C = cohortSql(u, c), isCur = `timestamp >= ${START}`
  const v = { ...filter.values, path }
  const clicksBoth = `event IN ('$autocapture', '$rageclick', '$dead_click') AND (event != '$autocapture' OR properties.$event_type = 'click') AND ${PATH} AND ${BOTH} AND ${filter.sql}${C}`
  const clicks = `event IN ('$autocapture', '$rageclick', '$dead_click') AND (event != '$autocapture' OR properties.$event_type = 'click') AND ${PAGE_FILTER} AND ${filter.sql}${C}`
  const newOrgs = `(SELECT ${o} FROM events WHERE event = '$pageview' AND ${PATH} AND timestamp >= now() - INTERVAL 30 DAY AND ${o} != '' GROUP BY ${o} HAVING min(timestamp) >= now() - INTERVAL 7 DAY)`
  const usageSql = `SELECT countIf(event = '$autocapture') AS clicks, uniq(person_id) AS people, uniqIf(${o}, ${o} != '') AS ${u.label.replace(/\W/g, '_')}, countIf(event = '$rageclick') AS rage, countIf(event = '$dead_click') AS dead\nFROM events\nWHERE ${clicks}`
  const r: Record<string, any[][] | null> = { usage: null, trend: null, errs: null, replays: null, powerOrgs: null, powerPeople: null, names: null, emails: null, every: null, be: null, fails: null }

  const build = (final: boolean) => {
    const u0 = r.usage?.[0] ?? []
    const hours = new Map((r.trend ?? []).map(x => [Number(x[0]), x[1]]))
    const hourNow = Math.floor(Date.now() / 3600_000) * 3600
    const from = Number(u0[4]) || hourNow - 23 * 3600
    const series = r.trend ? Array.from({ length: Math.max(1, Math.round((hourNow - from) / 3600) + 1) }, (_, i) => hours.get(from + i * 3600) ?? 0) : null
    const orgName = new Map((r.names ?? []).map(x => [String(x[0]), x[1]])), email = new Map((r.emails ?? []).map(x => [String(x[0]), x[1]]))
    return {
      unit: u.label, cohort: c, partial: !final,
      loading: final ? null : { usage: !r.usage, errors: !r.errs, backend: !r.be, replays: !r.replays, power: !r.powerPeople, allPages: !r.every },
      allPages: r.every?.[0] ? { clicks: r.every[0][0], people: r.every[0][1] } : null,
      backend: r.be ? {
        requests: r.be.map(x => { const ids = (x[5] ?? []).filter((y: any) => y && y !== 'null'); return { type: x[0] ?? 'request', count: x[1], p50: x[2], p95: x[3], slow: x[4], logs: ids.length ? logsUrl(base, project, ids) : null } }),
        failures: r.fails?.[0]?.[0] ?? 0,
      } : null,
      howto: {
        rule: `Clicks${norm ? ' on this control (a click on its icon or label counts for it)' : ' on this element'} on pages matching ${path}, in the last 24 hours, from PostHog autocapture${c === 'new' ? `, only ${u.label} new to the page in the last 7 days` : ''}. Rage and dead clicks are PostHog's $rageclick and $dead_click events on the same element.`,
        sql: inlineSql(usageSql, v),
        sqlUrl: sqlUrl(base, project, inlineSql(usageSql, v)),
        insightUrl: norm ? insightUrl(base, project, path, norm) : null,
      },
      ...(r.usage ? { clicks: u0[0] ?? 0, people: u0[1] ?? 0, rage: u0[2] ?? 0, dead: u0[3] ?? 0, orgs: u0[5] ?? 0, prevOrgs: u0[6] ?? 0, prevClicks: u0[7] ?? 0 } : {}),
      trend: series,
      errors: r.errs ? r.errs.map(x => ({ type: x[0] ?? 'Error', value: x[1] ?? '', count: x[2], orgs: x[3], noise: isNoise(x[0] ?? '', x[1] ?? '') })) : null,
      errorTotal: (r.errs ?? []).reduce((n, x) => n + x[2], 0),
      sessions: r.replays ? r.replays.map(x => ({ id: x[0], url: `${base}/project/${project}/replay/${x[0]}`, why: [x[4] ? `new ${u.singular}` : '', x[3] ? 'error' : '', x[2] ? 'rage click' : ''].filter(Boolean) })) : null,
      power: r.powerPeople ? {
        orgs: (r.powerOrgs ?? []).map(x => ({ name: orgName.get(String(x[0])) || String(x[0]).slice(0, 8), clicks: x[1], url: `${base}/project/${project}/groups/${u.index}/${encodeURIComponent(String(x[0]))}` })),
        people: r.powerPeople.map(x => ({ email: email.get(String(x[0])) || String(x[1]).slice(0, 12), clicks: x[2], url: `${base}/project/${project}/person/${encodeURIComponent(String(x[1]))}` })),
      } : null,
    }
  }
  const got = (k: string) => (rows: any[][]) => { r[k] = rows; emit?.(build(false)); return rows }
  const soft = (k: string) => (p: Promise<any[][]>) => p.catch(() => [] as any[][]).then(got(k))

  await Promise.all([
    // first: the headline numbers and the hourly shape
    q(`SELECT countIf(event = '$autocapture' AND ${isCur}), uniqIf(person_id, ${isCur}), countIf(event = '$rageclick' AND ${isCur}), countIf(event = '$dead_click' AND ${isCur}), toUnixTimestamp(${START}),
         uniqIf(${o}, ${isCur} AND ${o} != ''), uniqIf(${o}, NOT ${isCur} AND ${o} != ''), countIf(event = '$autocapture' AND NOT ${isCur})
       FROM events WHERE ${clicksBoth}`, v).then(got('usage')),
    soft('trend')(q(`SELECT toUnixTimestamp(toStartOfHour(timestamp)) h, count() FROM events WHERE ${clicks} GROUP BY h ORDER BY h`, v)),
    soft('errs')(q(`SELECT e.properties.$exception_types[1] t, substring(toString(e.properties.$exception_values[1]), 1, 120) val, count() n, uniq(c.org) orgs
       FROM events e INNER JOIN (SELECT $session_id sid, timestamp ts, ${o} org FROM events WHERE ${clicks}) c ON e.$session_id = c.sid
       WHERE e.event = '$exception' AND e.timestamp >= ${START} AND e.timestamp >= c.ts AND e.timestamp <= c.ts + INTERVAL 10 SECOND
       GROUP BY t, val ORDER BY orgs DESC, n DESC LIMIT 5`, v)),
    // Backend: the API requests a click on this control sets off (frontend timings joined by session and
    // the 5s after the click), with their request ids so the card links to the backend's log lines.
    // Products that don't report per-request timing ('query api response' is PostHog's own) get none.
    Promise.all([
      q(`SELECT r.qt, count() n, quantile(0.5)(r.ms) p50, quantile(0.95)(r.ms) p95, countIf(r.ms > 3000) slow, groupArray(25)(r.rid) rids
        FROM (SELECT $session_id sid, timestamp ts, properties.query_type qt, toFloat(properties.total_time_ms) ms, toString(properties.http_request_id) rid
              FROM events WHERE event = 'query api response' AND ${PAGE_FILTER}${C}) r
        INNER JOIN (SELECT $session_id sid, timestamp ts FROM events WHERE ${clicks} AND event = '$autocapture') c ON r.sid = c.sid
        WHERE r.ts >= c.ts AND r.ts <= c.ts + INTERVAL 5 SECOND
        GROUP BY r.qt ORDER BY n DESC LIMIT 5`, v).catch(() => [] as any[][]),
      q(`SELECT count() FROM events e INNER JOIN (SELECT $session_id sid, timestamp ts FROM events WHERE ${clicks} AND event = '$autocapture') c ON e.$session_id = c.sid
        WHERE e.event = 'client_request_failure' AND e.timestamp >= ${START} AND e.timestamp >= c.ts AND e.timestamp <= c.ts + INTERVAL 5 SECOND`, v).catch(() => [] as any[][]),
    ]).then(([be, fails]) => { r.fails = fails; got('be')(be) }),
    // The replays worth watching: a new team > an error after the click > a rage click > most recent.
    // Only sessions that were actually recorded.
    soft('replays')(q(`SELECT sid, any(org) org, max(rage) rage, max(err) err, max(isnew) isnew, max(ts) lastts FROM (
         SELECT $session_id sid, ${o} org, event = '$rageclick' rage, timestamp ts,
           $session_id IN (SELECT $session_id FROM events WHERE event = '$exception' AND ${PAGE_FILTER}) err,
           ${o} IN ${newOrgs} isnew
         FROM events WHERE ${clicks} AND $session_id != '')
       WHERE sid IN (SELECT session_id FROM raw_session_replay_events WHERE min_first_timestamp >= ${START} - INTERVAL 1 DAY)
       GROUP BY sid ORDER BY isnew DESC, err DESC, rage DESC, lastts DESC LIMIT 3`, v)),
    Promise.all([
      u.index != null ? q(`SELECT ${o} k, count() n FROM events WHERE ${clicks} AND ${o} != '' GROUP BY k ORDER BY n DESC LIMIT 3`, v).catch(() => [] as any[][]) : Promise.resolve([] as any[][]),
      q(`SELECT person_id, any(distinct_id), count() n, any(coalesce(nullIf(toString(person.properties.email), ''), distinct_id)) FROM events WHERE ${clicks} GROUP BY person_id ORDER BY n DESC LIMIT 3`, v).catch(() => [] as any[][]),
    ]).then(async ([orgs, people]) => {
      const [names, emails] = await Promise.all([
        orgs.length ? q(`SELECT key, properties.name FROM groups WHERE index = ${u.index} AND key IN {keys}`, { keys: orgs.map(x => String(x[0])) }).catch(() => [] as any[][]) : [],
        people.map(x => [x[0], x[3]]) as any[][],
      ])
      r.powerOrgs = orgs; r.names = names; r.emails = emails; got('powerPeople')(people)
    }),
    // last: the same control on every page (a nav item is clicked everywhere), only with a stable identity
    norm && (norm.text || norm.attr || norm.id || norm.aria || norm.href)
      ? soft('every')(q(`SELECT countIf(event = '$autocapture'), uniq(person_id) FROM events WHERE ${CLICKISH} AND ${CUR} AND ${filter.pre ? filter.pre + ' AND ' : ''}${filter.sql}${C}`, v))
      : Promise.resolve(got('every')([])),
  ])
  return build(true)
}
