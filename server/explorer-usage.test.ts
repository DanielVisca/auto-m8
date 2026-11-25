import { test } from 'node:test'
import assert from 'node:assert/strict'
import { manifestSegments, shapeOf } from './explorer-usage.ts'

test('manifestSegments reads the first path segment of every url a product declares', () => {
  const src = "export const manifest = {\n    urls: {\n        dashboards: (tab?: string): string => (tab ? `/dashboard?tab=${tab}` : '/dashboard'),\n        sharedDashboard: (t: string): string => `/shared_dashboard/${t}`,\n    },\n    fileSystemTypes: {},\n}"
  assert.deepEqual(manifestSegments(src), ['dashboard', 'shared_dashboard'])
})
test('shapeOf: steady, growing, spiky', () => {
  assert.equal(shapeOf([100, 101, 99, 100, 102, 98, 100, 101, 99, 100, 100, 101]).trend, 'steady')
  const g = shapeOf([50, 50, 50, 50, 50, 50, 50, 50, 80, 80, 80, 80])
  assert.equal(g.trend, 'growing'); assert.ok(g.change! > 0.5)
  assert.equal(shapeOf([10, 90, 5, 100, 8, 95, 12, 88, 10, 90, 6, 100]).spiky, true)
})
