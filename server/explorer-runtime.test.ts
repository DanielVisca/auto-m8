import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distributedCluster, matchTables, nodeKey, originOf, sqlTableNames, tfInstanceTypes } from './explorer-runtime.ts'

const code = [{ image: 'x', sha: 'a'.repeat(40), repo: '/r', behind: 0, ahead: 0, github: null }]
test('an image tagged with a commit in your repos is your code', () => {
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/posthog-node:' + 'a'.repeat(40)], code, 'PostHog'), 'yours')
})
test('version-tagged public and mirrored images are third-party', () => {
  assert.equal(originOf(['public.ecr.aws/warpstream-labs/warpstream_agent:v843'], [], 'PostHog'), 'third-party')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/dhi/kube-state-metrics:2.20-debian13@sha256:96a2'], [], 'PostHog'), 'third-party')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/mirror/docker-hub/prometheuscommunity/pgbouncer-exporter:v0.12.0'], [], 'PostHog'), 'third-party')
})
test("your org's registry with a digest only, or a commit we can't find, is org-built", () => {
  assert.equal(originOf(['ghcr.io/posthog/statuspage-metrics-api@sha256:6c16'], [], 'PostHog'), 'org')
  assert.equal(originOf(['123.dkr.ecr.us-east-1.amazonaws.com/capture:' + 'b'.repeat(40)], [], 'PostHog'), 'org')
  assert.equal(originOf([], [], 'PostHog'), 'unknown')
})

test('terraform instance types carry file:line and the block they sit in', () => {
  const tf = [
    'module "clickhouse_metrics" {',
    '  source = "../modules/clickhouse"',
    '  instance_type = "r7gd.4xlarge" # data nodes',
    '  nodes = {',
    '    "ch-9e" = {',
    '      instance_type = "i4g.8xlarge"',
    '    }',
    '  }',
    '}',
    'inputs = {',
    '  node_type = "c7g.2xlarge"',
    '  instance_types = ["m7g.xlarge", "m7g.2xlarge"]',
    '  instance_type = "${var.x}"',
    '}',
  ].join('\n')
  const t = tfInstanceTypes(tf, 'terraform/environments/prod-us/clickhouse/main.tf')
  assert.deepEqual(t.map(x => [x.key, x.value, x.line, x.context.join(' › ')]), [
    ['instance_type', 'r7gd.4xlarge', 3, 'module clickhouse_metrics'],
    ['instance_type', 'i4g.8xlarge', 6, 'module clickhouse_metrics › nodes › ch-9e'],
    ['node_type', 'c7g.2xlarge', 11, 'inputs'],
    ['instance_types', 'm7g.xlarge', 12, 'inputs'],
    ['instance_types', 'm7g.2xlarge', 12, 'inputs'],
  ])
})

test('table names come from SQL, db_table and table-like literals', () => {
  const names = sqlTableNames([
    'query = f"SELECT count() FROM {CLICKHOUSE_DATABASE}.metrics4_samples WHERE team_id = %(team_id)s"',
    'INSERT INTO logs32 (uuid) VALUES',
    '        db_table = "posthog_metricalert"',
    "TABLE_NAME = 'sharded_logs'",
    'label = "hello world"',
  ].join('\n'))
  for (const n of ['metrics4_samples', 'logs32', 'posthog_metricalert']) assert.ok(names.includes(n), n)
  assert.ok(!names.includes('hello world'))
})

test('tables match by code, db_table or name, strongest first', () => {
  const tables = [
    { db: 'posthog', table: 'metrics4_samples', engine: 'Distributed', cluster: 'metrics' },
    { db: 'posthog', table: 'sharded_metrics4_samples', engine: 'ReplicatedMergeTree' },
    { db: 'posthog', table: 'logs32', engine: 'Distributed', cluster: 'logs' },
    { db: 'posthog', table: 'events', engine: 'Distributed', cluster: 'posthog' },
    { db: 'posthog', table: 'posthog_metricalert', engine: 'MergeTree' },
    { db: 'posthog', table: 'app_metrics2', engine: 'Distributed', cluster: 'aux' },
  ]
  const m = matchTables(tables, { tokens: ['metric'], codeNames: new Map([['metrics4_samples', 'products/metrics/backend/q.py:12']]), dbTables: ['posthog_metricalert'] })
  assert.deepEqual(m.map(x => x.table), ['metrics4_samples', 'posthog_metricalert', 'sharded_metrics4_samples'])
  assert.deepEqual(m[0].how, ['named in code at products/metrics/backend/q.py:12', 'table name starts with “metric”'])
  assert.equal(matchTables(tables, { tokens: ['log'], codeNames: new Map() }).map(x => x.table).join(), 'logs32')
})

test('Distributed engines name the cluster; node names line up across Prometheus and system.clusters', () => {
  assert.equal(distributedCluster("Distributed('posthog_metrics', 'posthog', 'sharded_metrics4_samples', rand())"), 'posthog_metrics')
  assert.equal(distributedCluster('ReplicatedMergeTree()'), null)
  assert.equal(nodeKey('prod-us-iad-ch-2c'), 'ch-2c')
  assert.equal(nodeKey('ch-2c.prod-us.internal'), 'ch-2c')
})
