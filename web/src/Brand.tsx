// Identifiers: neutral glyphs for local apps and sources (no third-party app icons ship with perch),
// and Simple Icons (CC0) marks for web services. Near-black marks follow the text colour so they
// stay visible in dark mode. Unknown names fall back to their initial.
import {
  siAsana, siAtlassian, siBox, siBrex, siCalendly, siCanva, siClaude, siClickup, siCloudflare, siFigma, siGit, siGithub, siGmail,
  siGooglecalendar, siGoogledocs, siGoogledrive, siGooglesheets, siGrafana, siHubspot, siIntercom, siLinear, siNotion, siOllama, siOpenai, siSalesforce,
  siSentry, siShopify, siStrava, siStripe, siSupabase, siTodoist, siTrello, siVercel, siZapier, siZoom,
} from 'simple-icons'

// Generic glyphs, not logos: what kind of thing it is (a browser, a chat, an editor), not whose.
const APPS: Record<string, string> = {
  claude: '💬', posthog: '📊', slack: '#', chrome: '🌐', cursor: '⌖', terminal: '›_', finder: '📁', notes: '📝', obsidian: '🗒', vscode: '{}',
}
type SI = { path: string; hex: string; title: string }
// Use OpenAI's monochrome mark so it follows the text colour in light and dark themes.
const OPENAI = { ...siOpenai, hex: '000000' }
const MARKS: Record<string, SI> = {
  github: siGithub, grafana: siGrafana, git: siGit, 'google drive': siGoogledrive, 'google calendar': siGooglecalendar, gmail: siGmail,
  'google docs': siGoogledocs, 'google sheets': siGooglesheets, notion: siNotion, linear: siLinear, figma: siFigma, sentry: siSentry,
  vercel: siVercel, supabase: siSupabase, stripe: siStripe, atlassian: siAtlassian, asana: siAsana, hubspot: siHubspot, trello: siTrello,
  clickup: siClickup, zapier: siZapier, canva: siCanva, intercom: siIntercom, cloudflare: siCloudflare, zoom: siZoom, todoist: siTodoist,
  salesforce: siSalesforce, shopify: siShopify, box: siBox, calendly: siCalendly, brex: siBrex, strava: siStrava, 'claude-mark': siClaude, ollama: siOllama,
  codex: OPENAI, chatgpt: OPENAI, openai: OPENAI,
}
const dark = (hex: string) => { const n = parseInt(hex, 16); return ((n >> 16) + ((n >> 8) & 255) + (n & 255)) / 3 < 60 }

// Picks the brand for any name: "claude.ai Google Drive", "plugin:slack:slack", "posthog-dev", "GitHub Copilot MCP"…
export function brandFor(name: string): string | null {
  const n = name.toLowerCase().replace(/^claude\.ai\s+|^plugin:[^:]+:/, '')
  if (n in APPS) return n
  if (/posthog/.test(n)) return 'posthog'
  if (/slack/.test(n)) return 'slack'
  if (/github/.test(n)) return 'github'
  if (/claude docs|^claude/.test(n)) return 'claude'
  for (const k of Object.keys(MARKS)) if (n.includes(k)) return k
  if (/microsoft|outlook/.test(n)) return null
  return null
}

export function Brand({ id, size = 14, title }: { id: string | null | undefined; size?: number; title?: string }) {
  if (!id) return null
  if (id in APPS) return <span className="brand brand-glyph" role="img" aria-label={title ?? id} style={{ width: size, height: size, fontSize: size * (APPS[id].length > 1 && !/\p{Extended_Pictographic}/u.test(APPS[id]) ? 0.55 : 0.8) }} title={title ?? id}>{APPS[id]}</span>
  const m = MARKS[id]
  if (m) return (
    <svg className="brand" width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title ?? m.title}>
      <title>{title ?? m.title}</title><path d={m.path} fill={dark(m.hex) ? 'currentColor' : `#${m.hex}`} />
    </svg>
  )
  return <span className="brand brand-letter" style={{ width: size, height: size, fontSize: size * 0.62 }} title={title ?? id}>{id[0]?.toUpperCase()}</span>
}

// Where a conversation came from, as one icon.
export const sourceBrand = (c: { source: string; origin?: string | null }) =>
  c.source === 'import' ? 'notes' : c.source === 'cursor' ? 'cursor' : c.source === 'claude' ? 'claude' : c.source === 'posthog-code' ? 'posthog' : c.origin === 'slack' ? 'slack' : 'posthog'
