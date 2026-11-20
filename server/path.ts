// The server is started through a login shell (zsh -lc), which reads ~/.zprofile but not ~/.zshrc.
// The native Claude Code installer puts `claude` in ~/.local/bin and adds that to PATH only in
// ~/.zshrc, so without this every spawn('claude') fails with ENOENT ("spawn claude ENOENT" in
// Settings → Connections). Add the usual install folders so claude, gh and friends are found
// however perch was launched. Imported first by main.ts so it runs before anything spawns.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function withToolDirs(path = '', home = homedir()) {
  const have = path.split(delimiter).filter(Boolean)
  const extra = [join(home, '.local/bin'), join(home, '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin'), join(home, 'bin')]
    .filter(d => !have.includes(d) && existsSync(d))
  return [...extra, ...have].join(delimiter)
}

process.env.PATH = withToolDirs(process.env.PATH)
