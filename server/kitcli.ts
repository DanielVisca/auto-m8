// Kits from the command line (docs/kits.md).
//   node server/kitcli.ts export --name <kit> --out <dir> [--skills a,b] [--routines "Name 1,Name 2"] [--db perch.db]
//        [--instructions snippet.md] [--forbid patterns.txt] [--description ..] [--author ..] [--sub "Literal=owner.name" ...]
//   node server/kitcli.ts import <dir or git URL> [--dry-run] [--only skill:a,routine:B]
//   node server/kitcli.ts list
//   node server/kitcli.ts remove <kit>
// Export always substitutes your auto-m8 name, home folder and code folder; --sub adds more.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exportKit, readForbid, VARS, type Var } from './kitexport.ts'

const [cmd, ...rest] = process.argv.slice(2)
const { values: a, positionals } = parseArgs({
  args: rest, allowPositionals: true, options: {
    name: { type: 'string' }, out: { type: 'string' }, skills: { type: 'string' }, routines: { type: 'string' }, db: { type: 'string' },
    instructions: { type: 'string' }, forbid: { type: 'string' }, description: { type: 'string' }, author: { type: 'string' },
    version: { type: 'string' }, sub: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, only: { type: 'string' },
  },
})
const list = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean)

if (cmd === 'export') {
  if (!a.name || !a.out) { console.error('export needs --name and --out'); process.exit(2) }
  const { ownerName } = await import('./owner.ts')
  const home = homedir()
  const data = process.env.PERCH_DATA ?? join(home, 'Library/Application Support/perch')
  let codeDir = join(home, 'Development')
  try { codeDir = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')).chat?.cwd || codeDir } catch {}
  const subs: [string, Var][] = [[ownerName(), 'owner.name'], [codeDir, 'codeDir'], [codeDir.replace(home, '~'), 'codeDir'], [home, 'home']]
  for (const s of a.sub ?? []) {
    const i = s.lastIndexOf('='), lit = s.slice(0, i), v = s.slice(i + 1) as Var
    if (i < 1 || !VARS.includes(v)) { console.error(`--sub "${s}": want Literal=${VARS.join('|')}`); process.exit(2) }
    subs.push([lit, v])
  }
  const r = exportKit({
    name: a.name, out: a.out, description: a.description, author: a.author, version: a.version,
    skills: list(a.skills), routines: list(a.routines), db: a.db ?? (a.routines ? join(data, 'perch.db') : undefined),
    instructions: a.instructions, subs, forbid: a.forbid ? readForbid(readFileSync(a.forbid, 'utf8')) : [],
  })
  if (r.hits.length) {
    console.error(`Scrub gate: ${r.hits.length} personal value(s) left, nothing written.`)
    for (const h of r.hits.slice(0, 60)) console.error(`  ${h.file}:${h.line}  ${h.match}`)
    if (r.hits.length > 60) console.error(`  … ${r.hits.length - 60} more`)
    process.exit(1)
  }
  console.log(`Wrote kit "${r.manifest.name}" (${r.manifest.skills.length} skills, ${r.manifest.routines.length} routines${r.manifest.instructions ? ', instructions' : ''}) to ${a.out}`)
} else if (cmd === 'import' || cmd === 'list' || cmd === 'remove') {
  const kits = await import('./kits.ts')
  const { values, paths } = await kits.myValues()
  if (cmd === 'list') { for (const k of kits.installed()) console.log(`${k.kit}  ${k.version}  ${k.items} items`) }
  else if (cmd === 'remove') {
    if (!positionals[0]) { console.error('remove needs a kit name'); process.exit(2) }
    const r = kits.remove(positionals[0], paths)
    console.log(`Removed ${r.removed.length} item(s).${r.kept.length ? ` Kept (you edited them): ${r.kept.join(', ')}` : ''}`)
  } else {
    if (!positionals[0]) { console.error('import needs a folder or git URL'); process.exit(2) }
    const k = kits.openKit(positionals[0])
    try {
      const items = a['dry-run'] ? kits.plan(k, values, paths) : kits.apply(k, values, paths, a.only ? list(a.only) : undefined)
      console.log(`${a['dry-run'] ? 'Would import' : 'Imported'} kit "${k.manifest.name}" ${k.manifest.version}:`)
      for (const i of items) console.log(`  ${i.action.padEnd(10)} ${i.kind}:${i.name}${i.note ? `  (${i.note})` : ''}`)
    } finally { k.cleanup() }
  }
} else {
  console.error('usage: node server/kitcli.ts export|import|list|remove …  (see the top of server/kitcli.ts)')
  process.exit(2)
}
