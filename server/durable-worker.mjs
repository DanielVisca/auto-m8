// A tiny supervisor outlives the Perch server. The child writes to files, never to server-owned
// pipes. Keep its exit status too, including signals and spawn errors, for the next server.
import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'

const [statusPath, command, ...args] = process.argv.slice(2)
let finished = false
const finish = (code, signal, error) => {
  if (finished) return
  finished = true
  writeFileSync(`${statusPath}.tmp`, JSON.stringify({ code, signal, error, at: Date.now() }), { mode: 0o600 })
  renameSync(`${statusPath}.tmp`, statusPath)
}
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
child.on('error', e => finish(1, null, e.message))
child.on('close', (code, signal) => finish(code, signal, null))
// Interrupts target the whole process group. Stay alive long enough to record the child's exit.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {})
