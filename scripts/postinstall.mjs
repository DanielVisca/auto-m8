// node-pty ships spawn-helper without the execute bit, which fails every spawn with
// "posix_spawnp failed". Fix it after each install.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
const dir = 'node_modules/node-pty/prebuilds'
if (existsSync(dir)) for (const arch of readdirSync(dir)) {
  const helper = `${dir}/${arch}/spawn-helper`
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
