import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A throwaway HOME: subscriptions make folders and symlinks there, never in the real one. Not
// setting PERCH_SUBSCRIPTIONS_FILE: the default path (this profile's own dataDir) is what's tested.
const home = mkdtempSync(join(tmpdir(), 'perch-subs-'))
process.env.HOME = home
delete process.env.PERCH_PROFILE
mkdirSync(join(home, '.claude/projects'), { recursive: true })
mkdirSync(join(home, '.claude-personal'), { recursive: true }) // the Personal profile's own folder
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { posthog: { command: 'x' } }, oauthAccount: { emailAddress: 'secret@example.com' } }))
writeFileSync(join(home, '.claude/settings.json'), '{}')
const S = await import('./subscriptions.ts')
const P = await import('./profile.ts')

test('the profile logins (Claude and OpenAI) are listed without connecting anything; this profile comes first', () => {
  const subs = S.subscriptions()
  assert.equal(subs[0].id, 'claude-work')
  assert.equal(subs[0].dir, join(home, '.claude'))
  assert.ok(subs.some(s => s.id === 'openai-work' && s.provider === 'openai' && s.dir === join(home, '.codex')))
  // Work borrows Personal by default, so Personal's logins show up here too.
  assert.ok(subs.some(s => s.id === 'claude-personal' && s.dir === join(home, '.claude-personal')))
  assert.ok(subs.some(s => s.id === 'openai-personal' && s.dir === join(home, '.codex-personal')))
  assert.ok(subs.every(s => s.builtin))
})

test('borrowing is one-directional: Personal does not borrow back by default, and turning it off hides Personal here', () => {
  const all = P.profiles()
  assert.deepEqual(all.find(p => p.id === 'work')!.borrows, ['personal'])
  assert.deepEqual(all.find(p => p.id === 'personal')!.borrows, [], "Personal doesn't see Work's logins by default")
  P.saveProfiles(ps => ps.map(p => p.id === 'work' ? { ...p, borrows: [] } : p))
  assert.ok(!S.subscriptions().some(s => s.id === 'claude-personal' || s.id === 'openai-personal'))
  P.saveProfiles(ps => ps.map(p => p.id === 'work' ? { ...p, borrows: ['personal'] } : p)) // restore for later tests
  assert.ok(S.subscriptions().some(s => s.id === 'claude-personal'))
})

test('a connected Claude subscription shares transcripts, settings and MCP servers but never the login', () => {
  const sub = S.addSubscription('claude', 'PostHog Team')
  assert.equal(sub.id, 'claude-posthog-team')
  assert.equal(sub.dir, join(home, '.claude-posthog-team'))
  assert.ok(lstatSync(join(sub.dir, 'projects')).isSymbolicLink())
  assert.equal(readlinkSync(join(sub.dir, 'projects')), join(home, '.claude/projects'))
  assert.ok(lstatSync(join(sub.dir, 'settings.json')).isSymbolicLink())
  const cfg = JSON.parse(readFileSync(join(sub.dir, '.claude.json'), 'utf8'))
  assert.deepEqual(cfg.mcpServers, { posthog: { command: 'x' } })
  assert.equal(cfg.oauthAccount, undefined, 'the login is not copied')
  assert.equal(S.addSubscription('claude', 'PostHog Team').id, 'claude-posthog-team-2', 'same name twice gets its own id')
})

test('a connected OpenAI subscription is its own CODEX_HOME sharing sessions and config', () => {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), 'model = "gpt-5"\n')
  const sub = S.addSubscription('openai', 'ChatGPT Team')
  assert.equal(sub.dir, join(home, '.codex-chatgpt-team'))
  assert.equal(readlinkSync(join(sub.dir, 'sessions')), join(home, '.codex/sessions'))
  assert.equal(readlinkSync(join(sub.dir, 'config.toml')), join(home, '.codex/config.toml'))
  assert.ok(!existsSync(join(sub.dir, 'auth.json')))
})

test('a chat picks a subscription per provider; the profile default is stored as unset', () => {
  assert.equal(S.chatSub('c1', 'claude'), null)
  S.setChatSub('c1', 'claude', 'claude-posthog-team')
  S.setChatSub('c1', 'openai', 'openai-chatgpt-team')
  assert.equal(S.chatSub('c1', 'claude'), 'claude-posthog-team')
  assert.deepEqual(S.codexEnvForChat('c1'), { CODEX_HOME: join(home, '.codex-chatgpt-team') })
  S.setChatSub('c1', 'claude', 'claude-work')
  assert.equal(S.chatSub('c1', 'claude'), null, 'picking the default clears the pin')
  S.setChatSub('c1', 'claude', 'openai-chatgpt-team')
  assert.equal(S.chatSub('c1', 'claude'), null, 'an OpenAI subscription never runs claude')
  assert.deepEqual(S.codexEnvForChat('nobody'), {})
})

test("moving a chat to a login with its own transcripts links the chat's transcript so --resume finds it", () => {
  const cwd = '/Users/x/proj'
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  mkdirSync(join(home, '.claude/projects', folder), { recursive: true })
  writeFileSync(join(home, '.claude/projects', folder, 'c2.jsonl'), '{}\n')
  // The Personal profile's folder keeps its own transcripts.
  const personal = S.subscriptions().find(s => s.id === 'claude-personal')!
  assert.ok(personal)
  S.setChatSub('c2', 'claude', 'claude-personal')
  assert.equal(S.claudeDirForChat('c2', cwd), personal.dir)
  assert.equal(readlinkSync(join(personal.dir, 'projects', folder, 'c2.jsonl')), join(home, '.claude/projects', folder, 'c2.jsonl'))
})

test('a removed subscription reads as unset for chats that used it, and built-ins cannot be removed', async () => {
  S.setChatSub('c3', 'claude', 'claude-posthog-team-2')
  assert.equal(S.chatSub('c3', 'claude'), 'claude-posthog-team-2')
  await S.removeSubscription('claude-posthog-team-2')
  assert.equal(S.chatSub('c3', 'claude'), null)
  assert.ok(!S.subscriptions().some(s => s.id === 'claude-posthog-team-2'))
  assert.ok('error' in await S.removeSubscription('claude-work'))
})

test('renaming a built-in keeps its id', () => {
  S.renameSubscription('claude-work', 'PostHog')
  assert.equal(S.subById('claude-work')?.label, 'PostHog')
})
