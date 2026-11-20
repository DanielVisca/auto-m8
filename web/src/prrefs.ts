// PR references written as text ("#135188", "PostHog/posthog#135188") become links, so they draw as pills too.
// A bare number only links when it can be pinned to one repo: a PR url seen in the same conversation,
// or (resolved by the caller) one PR perch knows with that number. Code and existing links are left alone.
export type PrKnown = Map<string, string> // "135188" or "posthog/posthog#135188" -> PR url ('' when ambiguous)
const URLS = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
export function knownPrs(texts: Iterable<string>): PrKnown {
  const m: PrKnown = new Map()
  const add = (u: string, o: string, r: string, n: string) => {
    m.set(`${o}/${r}#${n}`.toLowerCase(), u)
    const had = m.get(n)
    m.set(n, had === undefined || had.toLowerCase() === u.toLowerCase() ? had ?? u : '') // GitHub names are case-insensitive
  }
  for (const t of texts) {
    for (const [u, o, r, n] of t.matchAll(URLS)) add(u, o, r, n)
    // "PostHog/posthog#84649" in tool output names the repo as surely as a url (dotted names could be files).
    for (const [, o, r, n] of t.matchAll(REPO_REF)) if (!r.includes('.')) add(`https://github.com/${o}/${r}/pull/${n}`, o, r, n)
  }
  return m
}
const SKIP = /(```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]*>|https?:\/\/\S+)/
const REPO_REF = /(?<![\w/.\[@-])([A-Za-z0-9][\w-]*)\/([\w.-]*[\w-])#(\d+)\b/g
const BARE_REF = /(?<![\w/\[&#@-])#(\d{3,6})\b/g
export function bareRefs(text: string): string[] {
  return text.split(SKIP).filter((_, i) => i % 2 === 0).flatMap(seg => [...seg.matchAll(BARE_REF)].map(x => x[1]))
}
export function linkPrRefs(text: string, known: PrKnown): string {
  if (!text.includes('#')) return text
  return text.split(SKIP).map((seg, i) => i % 2 ? seg : seg
    .replace(REPO_REF, (all, o: string, r: string, n: string) => {
      // "server/main.ts#12" is a file, not a repo: dotted names only link when the conversation names that repo.
      const k = known.get(`${o}/${r}#${n}`.toLowerCase())
      if (!k && r.includes('.')) return all
      return `[${all}](${k || `https://github.com/${o}/${r}/pull/${n}`})`
    })
    .replace(BARE_REF, (all, n: string) => { const u = known.get(n); return u ? `[${all}](${u})` : all })).join('')
}
