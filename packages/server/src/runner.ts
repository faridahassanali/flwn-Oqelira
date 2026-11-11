import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { DockerSandbox, UUID } from './sandbox.js'

const secret = process.env.OQELIRA_RUNNER_TOKEN ?? ''
if (Buffer.byteLength(secret) < 32) throw new Error('Set a random OQELIRA_RUNNER_TOKEN of at least 32 bytes')
const expected = createHash('sha256').update(`Bearer ${secret}`).digest()
const runtime = process.env.OQELIRA_CONTAINER_RUNTIME
const image = process.env.OQELIRA_WORKER_IMAGE ?? 'oqelira-worker:local'
if (process.env.NODE_ENV === 'production' && (runtime !== 'runsc' || !image.includes('@sha256:'))) throw new Error('Production runner requires gVisor runsc and a digest-pinned worker image')
const sandbox = new DockerSandbox(image, runtime)
let active = 0
const server = createServer((req, res) => {
  const reply = (status: number, result: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)) }
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  void (async () => {
    const supplied = createHash('sha256').update(req.headers.authorization ?? '').digest()
    if (!timingSafeEqual(expected, supplied)) { reply(401, { error: 'Unauthorized' }); return }
    if (req.method !== 'POST' || req.url !== '/execute' || req.headers['content-type'] !== 'application/json') { reply(404, { error: 'Not found' }); return }
    if (active >= 8) { reply(429, { error: 'Runner capacity reached' }); return }
    active++
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1100000) { reply(413, { error: 'Tool input is too large' }); return }; chunks.push(chunk) }
      let data: { project?: string; name?: string; input?: unknown }
      try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { reply(400, { error: 'Invalid request' }); return }
      if (!data || typeof data.project !== 'string' || !UUID.test(data.project)) { reply(400, { error: 'Invalid project' }); return }
      const tool = sandbox.tools(data.project).find(t => t.spec.name === data.name)
      if (!tool) { reply(400, { error: 'Invalid tool' }); return }
      const output = await tool.run(data.input, { cwd: '/workspace', signal: controller.signal })
      reply(200, { output })
    } finally { active-- }
  })().catch(() => { if (!res.headersSent && !res.destroyed) reply(503, { error: 'Isolated operation failed' }) })
})
server.requestTimeout = 30000; server.headersTimeout = 15000
server.listen(Number(process.env.OQELIRA_RUNNER_PORT ?? 4321), process.env.OQELIRA_RUNNER_HOST ?? '127.0.0.1', () => console.log('Private sandbox runner ready'))
