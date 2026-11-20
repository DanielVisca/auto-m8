import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceOf } from './spend.ts'

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('prices input, output, cache reads and both cache write TTLs', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; writes 1.25× (5m) and 2× (1h) input.
  close(priceOf('claude-opus-5-5', {
    input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 2e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
  }), 4 + 20 + 0.2 + 5 + 8)
})

test('without the TTL split, cache writes count as 5-minute', () => {
  close(priceOf('claude-sonnet-5-5', { cache_creation_input_tokens: 1e6 }), 2.5)
})

test('fast mode doubles, web searches add a cent each, unknown models are free', () => {
  close(priceOf('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40)
  close(priceOf('claude-sonnet-5-5', { server_tool_use: { web_search_requests: 3 } }), 0.03)
  close(priceOf('qwen3-coder:30b', { input_tokens: 1e6 }), 0)
})

test('matches the most specific model first', () => {
  close(priceOf('claude-fable-5-2', { input_tokens: 1e6 }), 8)
  close(priceOf('claude-fable-5', { input_tokens: 1e6 }), 10)
  close(priceOf('claude-opus-4-8', { input_tokens: 1e6 }), 5)
  close(priceOf('claude-opus-4-1-20250805', { input_tokens: 1e6 }), 15)
  close(priceOf('claude-haiku-5-5', { input_tokens: 2e5 }), 0.1) // over 100K: 5×
})
