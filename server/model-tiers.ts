// Capability classes shared by the picker and provider handoffs. Slugs come from Codex's
// current catalog, so choosing a peer does not pin fallbacks to one model generation.
import type { Tier } from './router.ts'

export type ModelTier = 'frontier' | 'workhorse' | 'fast'
export function modelTier(model: string): ModelTier {
  if (/\b(opus|fable|astra)\b/i.test(model)) return 'frontier'
  if (/\b(haiku|luna)\b/i.test(model)) return 'fast'
  return 'workhorse'
}

export const claudePeer = (model: string): Tier => ({ frontier: 'opus', workhorse: 'sonnet', fast: 'haiku' } as const)[modelTier(model)]

const NEAREST: Record<ModelTier, ModelTier[]> = {
  frontier: ['frontier', 'workhorse', 'fast'],
  workhorse: ['workhorse', 'frontier', 'fast'],
  fast: ['fast', 'workhorse', 'frontier'],
}
export function codexPeer(model: string, models: { slug: string; tier: ModelTier }[], preferred: string | null): string | undefined {
  for (const tier of NEAREST[modelTier(model)]) {
    const peers = models.filter(m => m.tier === tier)
    if (peers.length) return peers.find(m => m.slug === preferred)?.slug ?? peers[0].slug
  }
  // No catalog yet: the configured model is safer than guessing an unavailable slug.
  return preferred ?? undefined
}
