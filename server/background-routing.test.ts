import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import { test } from 'node:test'
import { runTextJobs } from './job-fallback.ts'
import { chooseProvider } from './subscription-budget.ts'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes(source.slice(source.indexOf('export function ephemeral'), source.indexOf('// A stalled agent:')).replace('export function ephemeral', 'function ephemeral'))
const args = ['-p', 'Return JSON', '--model', 'sonnet', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
function fixture() {
  const attempts: { provider: string; emit: (ev: any) => void }[] = [], out: any[] = []
  const context: any = {
    settings: { local: { model: 'qwen', background: false } },
    localUpSync: () => true, localRoomSync: () => true, codexReadySync: () => true, allCapped: () => false,
    usageNow: () => ({ claude: { at: Date.now(), windows: [{ key: 'seven_day', pct: 0.8, resetsAt: Date.now() + 5 * 86400_000 }] }, codex: null }),
    chooseProvider, runTextJobs,
    localJob: (_a: any, emit: (ev: any) => void) => { attempts.push({ provider: 'local', emit }); return () => {} },
    codexJob: (_a: any, _cwd: any, emit: (ev: any) => void) => { attempts.push({ provider: 'codex', emit }); return () => {} },
    withCapFallback: (job: any, _fallback: any, emit: any) => job(emit), childEnv: () => ({}), claudeEnv: () => ({}),
    spawn: () => { assert.fail('pressure should keep these text jobs off Claude') },
  }
  vm.createContext(context); vm.runInContext(code, context)
  return { context, attempts, out, start: () => context.ephemeral(args, '/tmp', (ev: any) => out.push(ev)) }
}

test('housekeeping uses local automatically under weekly pressure and retries on the healthier cloud', () => {
  const f = fixture(); f.start()
  assert.equal(f.attempts[0].provider, 'local')
  f.attempts[0].emit({ type: 'result', is_error: true, result: '' })
  f.attempts[0].emit({ type: 'perch_done', code: 1, error: 'local timeout' })
  assert.equal(f.attempts[1].provider, 'codex')
  assert.equal(f.out.length, 0)
  f.attempts[1].emit({ type: 'result', is_error: false, result: '{"ok":true}' })
  f.attempts[1].emit({ type: 'perch_done', code: 0 })
  assert.equal(f.out.length, 2)
})

test('an offline local server immediately uses the healthier subscription', () => {
  const f = fixture(); f.context.localUpSync = () => false; f.start()
  assert.equal(f.attempts[0].provider, 'codex')
})

test('housekeeping skips the local model when the Mac has no room for it', () => {
  const f = fixture(); f.context.localRoomSync = () => false; f.start()
  assert.equal(f.attempts[0].provider, 'codex')
})
