// electron-builder hook: stop the build if the server's Node for this arch wasn't fetched
// (scripts/fetch-node.mjs). Without it the app opens and its server never starts.
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const ARCH = { 1: 'x64', 3: 'arm64', 4: 'universal' }
exports.default = async ctx => {
  const arch = ARCH[ctx.arch] ?? String(ctx.arch)
  const node = join(ctx.packager.projectDir, 'build/node', arch, 'node')
  if (!existsSync(node)) throw new Error(`missing ${node}: run node scripts/fetch-node.mjs ${arch}`)
}
