// The product name people and agents see, and the names that used to be "perch".
// New links and tool names use auto-m8; parsers accept both so old transcripts still work.

export const APP_NAME = 'auto-m8'

// Conversation links: auto-m8://<id>. perch://<id> is the old form, still accepted everywhere.
export const CONV_SCHEME = 'auto-m8://'
const CONV_PREFIX = /^(?:auto-m8|perch):\/\//
/** Regex source matching either scheme, for building bigger patterns. */
export const CONV_SCHEME_RE = '(?:auto-m8|perch):\\/\\/'
export const convLink = (id: string) => `${CONV_SCHEME}${id}`
export const isConvLink = (s: string) => CONV_PREFIX.test(s)
/** The conversation id from auto-m8://<id> or perch://<id> (a bare id passes through). */
export const convIdOf = (ref: string) => ref.replace(CONV_PREFIX, '').replace(/\/$/, '')

// The MCP server agents get. Tool names are mcp__auto-m8__<tool>; old transcripts say mcp__perch__<tool>.
export const MCP_SERVER = 'auto-m8'
const OUR_SERVERS = new Set(['auto-m8', 'auto_m8', 'perch'])
export const isOurMcpServer = (server: string) => OUR_SERVERS.has(server)
export const mcpTool = (tool: string) => `mcp__${MCP_SERVER}__${tool}`
/** The bare tool name if `name` is one of our MCP tools (old or new server name), else null. */
export const ourMcpTool = (name: string): string | null => {
  const m = /^mcp__(auto-m8|auto_m8|perch)__(.+)$/.exec(name)
  return m ? m[2] : null
}
/** Regex source matching our MCP tool prefix under any of its names. */
export const OUR_MCP_PREFIX_RE = 'mcp__(?:auto-m8|auto_m8|perch)__'
