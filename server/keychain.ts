// Secrets perch keeps live in the macOS keychain, never in settings.json:
// - the PostHog personal API key;
// - an optional Anthropic API key, passed to the claude processes perch starts as ANTHROPIC_API_KEY.
import { execFileSync } from 'node:child_process'
import { profile } from './profile.ts'
import { UNDER_TEST } from './settings.ts'

// One entry per profile: Work keeps the original name, others get their own.
const SERVICE = 'perch'
const accountName = (base: string) => profile.id === 'work' ? base : `${base}:${profile.id}`

function secret(base: string, opts: { skipUnderTest?: boolean } = {}) {
  const ACCOUNT = accountName(base)
  const skip = !!opts.skipUnderTest && UNDER_TEST
  let cached: string | null | undefined = skip ? null : undefined
  return {
    get(): string | null {
      if (cached !== undefined) return cached
      try {
        cached = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
      } catch { cached = null }
      return cached
    },
    set(value: string) {
      if (!skip) execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', value])
      cached = value
    },
    clear() {
      if (!skip) try { execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' }) } catch {}
      cached = null
    },
  }
}

const posthog = secret('posthog-api-key')
export const posthogKey = () => posthog.get()
export const setPosthogKey = (key: string) => posthog.set(key)
export const clearPosthogKey = () => posthog.clear()

// Tests never touch the real keychain for this one: it changes how every claude process is billed.
const anthropic = secret('anthropic-api-key', { skipUnderTest: true })
export const anthropicKey = () => anthropic.get()
export const setAnthropicKey = (key: string) => anthropic.set(key)
export const clearAnthropicKey = () => anthropic.clear()

// Optional Pangram key for the writing editor's AI-text check (docs.ts). Never sent anywhere else.
const pangram = secret('pangram-api-key', { skipUnderTest: true })
export const pangramKey = () => pangram.get() ?? process.env.PANGRAM_API_KEY ?? null
export const setPangramKey = (key: string) => pangram.set(key)
export const clearPangramKey = () => pangram.clear()
