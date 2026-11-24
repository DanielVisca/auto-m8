import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { cloneLayout, LAYOUT_DIR, listLayouts, loadLayout, problemWith, readTile, SHIPPED, tilePath } from './layout.ts'

const main = { id: 'main', type: 'block', content: { view: 'main' } }
const row = (...children: any[]) => ({ id: 'root', type: 'row', children })

test('shipped layouts are valid', () => {
  for (const [name, l] of Object.entries(SHIPPED)) assert.equal(problemWith(l), null, name)
})

test('a layout must show main exactly once, unhidden', () => {
  assert.match(problemWith(row({ id: 's', type: 'block', content: { view: 'sidebar' } }))!, /must show the "main" view/)
  assert.match(problemWith(row(main, { ...main, id: 'm2' }))!, /only appear once/)
  assert.match(problemWith(row({ ...main, hidden: true }))!, /can't be hidden/)
  assert.match(problemWith({ id: 'root', type: 'row', children: [{ id: 'c', type: 'column', hidden: true, children: [main] }] })!, /can't be hidden/)
  assert.equal(problemWith(row(main, { id: 'side', type: 'block', hidden: true, content: { view: 'sidebar' } })), null)
})

test('bad nodes, colours and tile paths are refused with a reason', () => {
  assert.match(problemWith(row(main, main))!, /used twice/)
  assert.match(problemWith(row(main, { id: 'x', type: 'grid' }))!, /type must be/)
  assert.match(problemWith({ ...row(main), colors: { accent: 'red' } })!, /#rgb/)
  assert.match(problemWith({ ...row(main), colors: { nope: '#fff' } })!, /isn't a colour/)
  assert.match(problemWith(row(main, { id: 't', type: 'block', content: { tile: '../../etc/passwd.html' } }))!, /inside the layouts folder/)
  assert.equal(tilePath('/etc/x.html'), null)
  assert.equal(tilePath('tiles/x.js'), null)
  assert.ok(tilePath('tiles/x.html')?.startsWith(LAYOUT_DIR))
})

test('a broken file keeps the last good layout and writes why', () => {
  mkdirSync(join(LAYOUT_DIR, 'tiles'), { recursive: true })
  const file = join(LAYOUT_DIR, 'mine.json')
  const good = { ...row(main, { id: 'clock', type: 'block', size: { px: 120 }, content: { tile: 'tiles/clock.html' } }), colors: { accent: '#ff8800' } }
  writeFileSync(file, JSON.stringify(good))
  assert.deepEqual(loadLayout('mine'), { name: 'mine', layout: good, shipped: false, error: null })
  writeFileSync(file, '{ not json')
  const broken = loadLayout('mine')
  assert.deepEqual(broken.layout, good)
  assert.match(broken.error!, /isn't valid JSON/)
  assert.match(readFileSync(join(LAYOUT_DIR, 'mine.error'), 'utf8'), /isn't valid JSON/)
  writeFileSync(file, JSON.stringify(good))
  assert.equal(loadLayout('mine').error, null)
  assert.equal(existsSync(join(LAYOUT_DIR, 'mine.error')), false)
})

test('a missing layout falls back to the default', () => {
  const l = loadLayout('gone')
  assert.equal(l.name, 'default')
  assert.match(l.error!, /doesn't exist/)
})

test('clone copies a shipped layout and never overwrites', () => {
  assert.deepEqual(cloneLayout('default', 'copy'), { name: 'copy' })
  assert.equal(JSON.parse(readFileSync(join(LAYOUT_DIR, 'copy.json'), 'utf8')).cloned_from, 'default')
  assert.match((cloneLayout('default', 'copy') as any).error, /already exists/)
  assert.match((cloneLayout('default', 'default') as any).error, /already exists/)
  assert.ok(listLayouts().some(l => l.name === 'copy' && !l.shipped))
})

test('tiles are read only from inside the folder', () => {
  writeFileSync(join(LAYOUT_DIR, 'tiles', 'hi.html'), '<b>hi</b>')
  assert.equal(readTile('tiles/hi.html'), '<b>hi</b>')
  assert.equal(readTile('../settings.json'), null)
})
