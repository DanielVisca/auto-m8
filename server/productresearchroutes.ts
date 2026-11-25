import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import * as R from './productresearch.ts'
import { researchTool } from './productresearchbrowser.ts'

type Route = (method: string, path: string, h: (m: RegExpMatchArray, req: IncomingMessage, res: ServerResponse, q: URLSearchParams) => any) => void
export function researchRoutes(route: Route, body: (req: IncomingMessage) => Promise<any>) {
  route('GET', '/api/product-research', () => R.overview())
  route('POST', '/api/product-research/products/:id/archive', async (m, req) => { try { return R.archiveProduct(decodeURIComponent(m[1]), (await body(req)).archived !== false) } catch (e: any) { return { error: e.message } } })
  route('POST', '/api/product-research/products/:id/delete', m => { try { return R.deleteProduct(decodeURIComponent(m[1])) } catch (e: any) { return { error: e.message } } })
  route('GET', '/api/product-research/items/:id', m => R.detail(decodeURIComponent(m[1])))
  route('POST', '/api/product-research/tool', async (_m, req, res) => {
    try { return await researchTool(await body(req)) }
    catch (e: any) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })) }
  })
  route('GET', '/api/product-research/evidence/:id/image', (m, _req, res) => {
    const file = R.screenshotFile(decodeURIComponent(m[1]))
    if (!file) { res.writeHead(404); res.end('No screenshot'); return }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
    createReadStream(file).pipe(res)
  })
  route('GET', '/api/product-research/export', (_m, _req, res) => {
    const o = R.overview()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="product-research.json"' })
    res.end(JSON.stringify({ version: 1, ...o, items: o.items.map(it => R.detail(it.id)) }, null, 2))
  })
}
