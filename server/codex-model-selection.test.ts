import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import { claudePeer, codexPeer, modelTier } from './model-tiers.ts'

// Real catalog parsing and job argv, with only the filesystem and process boundary replaced.
const source = readFileSync(new URL('./codex.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes([
  source.slice(source.indexOf('export function codexModels'), source.indexOf('export const codexBin')),
  source.slice(source.indexOf('const toml'), source.indexOf('const CODEX_CAP')),
  source.slice(source.indexOf('export function codexJob'), source.indexOf('export { codexMessageUuid')),
].join('\n').replaceAll('export ', ''))

test('background cap fallback passes the peer model to Codex and reports the actual model', () => {
  for (const [tier, expected] of [['haiku', 'gpt-6-luna'], ['sonnet', 'gpt-6.1-sol'], ['opus', 'gpt-6-astra']]) {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill() {} })
    const events: any[] = []
    let argv: string[] = []
    const context: any = {
      claudePeer, codexPeer, modelTier, join, HOME: '/fixture', Date,
      readFileSync: (path: string) => path.endsWith('config.toml') ? 'model = "gpt-6-astra"' : JSON.stringify({ models: [
        { slug: 'gpt-6-sol', priority: 4, visibility: 'list' },
        { slug: 'gpt-6.1-sol', priority: 1, visibility: 'list' },
        { slug: 'gpt-6-astra', priority: 3, visibility: 'list' },
        { slug: 'gpt-6-luna-hidden', priority: 0, visibility: 'hide' },
        { slug: 'gpt-6-luna', priority: 6, visibility: 'list' },
      ] }),
      existsSync: () => true, codexBin: () => '/codex',
      spawn: (_bin: string, args: string[]) => { argv = args; return proc },
    }
    vm.createContext(context); vm.runInContext(code, context)
    context.codexJob(['-p', 'Brief me', '--model', tier], '/fixture', (ev: any) => events.push(ev))
    assert.equal(argv[argv.indexOf('-m') + 1], expected)
    assert.ok(argv.includes('--ephemeral'))
    assert.ok(argv.includes('sandbox_mode="read-only"'))
    assert.ok(argv.includes('mcp_servers={}'))
    proc.stdout.emit('data', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Brief' } }) + '\n')
    proc.emit('exit', 0)
    assert.equal(events.find(ev => ev.type === 'result').model, `codex:${expected}`)
  }
})
