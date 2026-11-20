// The product overlay's pure parts: page path → regex, PostHog element chains → matchable items,
// and the CSRF headers that let cookie-authenticated PostHog queries through.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeLeaf, mergeFriction, normItems, pathPattern, toItems } from './overlay.ts'
import { cohortSql, inlineSql, isNoise, normFilter, rankAttention } from './overlayinsights.ts'
import { csrfHeaders } from './browser.ts'

test('pathPattern wildcards ids so every project shares one page', () => {
  const re = new RegExp(pathPattern('/project/2/logs'))
  assert.equal(pathPattern('/project/2/logs'), '^/project/[^/]+/logs/?$')
  assert.ok(re.test('/project/446448/logs'))
  assert.ok(re.test('/project/2/logs/'))
  assert.ok(!re.test('/project/2/logs/services'))
  assert.equal(pathPattern('/insights/0193f2a1-7c6e-7d5e-a5b4-0f1e2d3c4b5a/edit'), '^/insights/[^/]+/edit/?$')
  assert.equal(pathPattern('/'), '^/?$')
  assert.equal(pathPattern('/pricing.html'), '^/pricing\\.html/?$')
})

test('toItems keys elements by data-attr, then id, then a scoped tag + text', () => {
  const items = toItems([
    { type: '$autocapture', count: 51, elements: [{ tag_name: 'button', text: null, attributes: { 'attr__aria-label': 'Refresh' } }, { tag_name: 'div', attributes: { 'attr__data-attr': 'logs-viewer' } }] },
    { type: '$rageclick', count: 4, elements: [{ tag_name: 'input', attributes: { 'attr__data-attr': 'logs-search' } }] },
    { type: '$autocapture', count: 9, elements: [{ tag_name: 'a', attr_id: 'signup', attributes: {} }] },
    { type: '$autocapture', count: 3, elements: [{ tag_name: 'div', attributes: { 'attr__class': 'flex' } }] }, // nothing stable: dropped
  ])
  assert.equal(items.length, 3)
  assert.deepEqual([items[0].tag, items[0].scope, items[0].aria, items[0].label], ['button', 'logs-viewer', 'Refresh', 'Refresh'])
  assert.equal(items[0].match, '[data-attr="logs-viewer"] button [aria-label="Refresh"]')
  assert.deepEqual([items[1].attr, items[1].type, items[1].count], ['logs-search', '$rageclick', 4])
  assert.equal(items[2].match, '#signup')
})

test('csrfHeaders adds the token and a same-origin Referer to writes only', () => {
  assert.deepEqual(csrfHeaders('GET', 'https://us.posthog.com/api/x', 'posthog_csrftoken=abc'), {})
  assert.deepEqual(csrfHeaders('POST', 'https://us.posthog.com/api/x', 'sessionid=s; posthog_csrftoken=abc%3D'),
    { Referer: 'https://us.posthog.com/', Origin: 'https://us.posthog.com', 'X-CSRFToken': 'abc=' })
  assert.deepEqual(csrfHeaders('POST', 'https://ex.com/a', ''), {})
})

test('describeLeaf names a rage/dead click spot from its chain', () => {
  assert.equal(describeLeaf('button.LemonButton.LemonButton--has-icon.LemonButton--no-content', null, 'logs-table › logs-viewer'), 'icon button in logs-table › logs-viewer')
  assert.equal(describeLeaf('span.LemonButton__chrome', null, 'logs-table', 'button.LemonButton.LemonButton--has-icon.LemonButton--no-content'), 'icon button in logs-table')
  assert.equal(describeLeaf('div.flex.TaxonomicFilter__row', 'Timestamp', 'logs-table'), 'div "Timestamp" in logs-table')
  assert.equal(describeLeaf('header.LemonDrawer__header', null, ''), 'header.LemonDrawer__header')
})

test('mergeFriction folds state-class variants of one spot together', () => {
  const btn = 'button.LemonButton.LemonButton--has-icon.LemonButton--no-content'
  const out = mergeFriction([
    ['span.LemonButton__chrome', btn, null, 'logs-table', 1, 119, 60, 50],
    ['span.LemonButton__chrome', btn + '.LemonButton--active', null, 'logs-table', 0, 35, 28, 20],
    ['div', 'div', 'Timestamp', 'logs-table', 0, 8, 2, 0],
  ])
  assert.deepEqual([out[0].what, out[0].rage, out[0].dead, out[0].orgs, out[0].prevOrgs], ['icon button in logs-table', 1, 154, 88, 70])
  assert.deepEqual(out[0].locate, { tag: 'button', cls: ['LemonButton'], mods: ['LemonButton--has-icon', 'LemonButton--no-content'], text: undefined, scope: 'logs-table' })
  assert.equal(out.length, 2)
})

test('rankAttention puts new problems hitting many teams first and sinks noise', () => {
  const out = rankAttention([
    { kind: 'friction', title: 'old friction', detail: '', orgs: 40, prevOrgs: 40 },
    { kind: 'error', title: 'new error', detail: '', orgs: 6, prevOrgs: 0 },
    { kind: 'error', title: 'AbortError', detail: '', orgs: 30, prevOrgs: 10, noise: true },
    { kind: 'latency', title: 'growing slow query', detail: '', orgs: 9, prevOrgs: 3 },
    { kind: 'error', title: 'gone', detail: '', orgs: 0, prevOrgs: 5 },
  ])
  assert.deepEqual(out.map(a => a.title), ['new error', 'old friction', 'growing slow query', 'AbortError'])
  assert.equal(out[0].isNew, true)
})

test('cohortSql narrows to customers new to the page, by org group when there is one', () => {
  assert.equal(cohortSql({ index: 0, label: 'organizations', singular: 'organization' }, 'all'), '')
  const s = cohortSql({ index: 0, label: 'organizations', singular: 'organization' }, 'new')
  assert.match(s, /\$group_0 IN \(SELECT \$group_0 FROM events/)
  assert.match(s, /HAVING min\(timestamp\) >= now\(\) - INTERVAL 7 DAY/)
  assert.match(cohortSql({ index: null, label: 'people', singular: 'person' }, 'new'), /toString\(person_id\) IN/)
  assert.equal(isNoise('DOMException', 'AbortError: signal is aborted'), true)
  assert.equal(isNoise('Error', 'A server error occurred.'), false)
})

test('normItems gives one badge per control and drops what it cannot find', () => {
  const base = { tag: 'button', text: '', attr: '', scope: '', id: '', aria: '', href: '', bem: '', pbem: '' }
  const items = normItems([
    { norm: { ...base, text: 'Products', attr: 'today-rail-products' }, clicks: 30, rage: 1, dead: 0, people: 19, orgs: 19 },
    { norm: { ...base, tag: 'input', scope: 'logs-viewer', bem: 'LemonInput__input' }, clicks: 331, rage: 0, dead: 0, people: 100, orgs: 89 },
    { norm: { ...base, tag: 'div', scope: 'logs-table' }, clicks: 602, rage: 6, dead: 106, people: 222, orgs: 171 },
  ])
  assert.equal(items.length, 2)
  assert.deepEqual([items[0].match, items[0].clicks, items[0].people], ['[data-attr="today-rail-products"]', 30, 19])
  assert.equal(items[1].match, '[data-attr="logs-viewer"] input.LemonInput__input')
})

test('normFilter and inlineSql: the card query matches the badge identity, safely quoted', () => {
  const f = normFilter({ tag: 'button', text: "Bob's", attr: 'x' })
  assert.match(f.sql, /^elements_chain LIKE \{p_text\} AND elements_chain LIKE \{p_attr\} AND /)
  assert.equal(f.values.p_text, '%text="Bob\'s"%')
  assert.ok(!f.sql.includes('elements_chain_texts'))
  assert.equal(f.values.n_scope, '')
  const sql = inlineSql(`SELECT 1 WHERE a = {n_text} AND b IN {list}`, { n_text: "Bob's", list: ['a', 'b'] })
  assert.equal(sql, "SELECT 1 WHERE a = 'Bob\\'s' AND b IN ['a', 'b']")
})
