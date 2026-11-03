// 本机 Agent API：让外部程序（自己的脚本、Claude Code / Cursor 等通过 MCP、别的 AI 框架）读状态、下指令、收事件。
// 设 MC_AGENT_PORT 和 MC_AGENT_TOKEN（至少 24 位）才会开；默认只听 127.0.0.1。
//
// 边界：
// - 每个请求都要 Authorization: Bearer <令牌>，用定长比较，防时序猜测
// - 带 Origin 头的请求（浏览器发的）一律拒绝，Host 头必须是本机/配置的地址：网页没法借浏览器打过来（含 DNS 重绑定）
// - 请求体最多 16KB、只收 JSON；每分钟最多 120 个请求；事件流最多 4 个连接
// - 指令和玩家在聊天里下的走同一套校验（normalizeAction），扩展指令同样只认合法参数
// - 令牌永不写日志
const http = require('node:http')
const { timingSafeEqual, createHash } = require('node:crypto')
const { createRateLimiter } = require('./security')

const MAX_BODY = 16 * 1024
const MAX_STREAMS = 4
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

function tokenMatcher(token) {
  const want = createHash('sha256').update(token).digest()
  return (got) => typeof got === 'string' && timingSafeEqual(createHash('sha256').update(got).digest(), want)
}

// 最近的事件留一份环形缓冲，轮询型客户端（MCP）用 since 取增量
function createEventLog(size = 200) {
  const items = []
  let seq = 0
  const listeners = new Set()
  return {
    push(type, data = {}) {
      const event = { id: ++seq, at: Date.now(), type, ...data }
      items.push(event)
      if (items.length > size) items.shift()
      for (const fn of listeners) { try { fn(event) } catch {} }
      return event
    },
    since(id = 0, limit = 50) { return items.filter((e) => e.id > id).slice(0, limit) },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    last: () => seq,
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(text)
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('只收 application/json'), { status: 415 }))
    const tooBig = () => Object.assign(new Error('请求体超过 16KB'), { status: 413, close: true })
    if (Number(req.headers['content-length']) > MAX_BODY) return reject(tooBig())
    let size = 0
    let over = false
    const chunks = []
    req.on('data', (c) => {
      if (over) return
      size += c.length
      // 超了就不再收，先回 413 再断开（直接 destroy 对方收不到回复）
      if (size > MAX_BODY) { over = true; chunks.length = 0; reject(tooBig()); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
        resolve(v)
      } catch { reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

// handlers: state() / commands() / command({cmd,args,wait}) / say(text) / ask(text) / stop() / workflows() / runWorkflow(name)
function createAgentApi({ port, host = '127.0.0.1', token, handlers, events = createEventLog(), log = console.log }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MC_AGENT_PORT 必须是 1024 到 65535')
  if (typeof token !== 'string' || token.length < 24 || /\s/.test(token)) throw new Error('MC_AGENT_TOKEN 至少 24 位且不能有空白（可以用 openssl rand -hex 24 生成）')
  if (!LOOPBACK.has(host)) log(`[agent] 注意：Agent API 监听在 ${host}，局域网里能连到它的人只要拿到令牌就能控制机器人`)
  const authorized = tokenMatcher(token)
  const limit = createRateLimiter({ limit: 120, windowMs: 60_000 })
  const allowedHosts = new Set([...LOOPBACK, host].flatMap((h) => [h, `${h}:${port}`, `[${h}]:${port}`]))
  let streams = 0

  const routes = {
    'GET /v1/state': async () => handlers.state(),
    'GET /v1/commands': async () => handlers.commands(),
    'GET /v1/workflows': async () => handlers.workflows(),
    'GET /v1/events/recent': async (_body, url) => {
      const since = Number(url.searchParams.get('since') || 0)
      return { last: events.last(), events: events.since(Number.isSafeInteger(since) && since >= 0 ? since : 0) }
    },
    'POST /v1/command': async (body) => {
      if (typeof body.cmd !== 'string') throw Object.assign(new Error('需要 cmd'), { status: 400 })
      const args = body.args === undefined ? [] : body.args
      if (!Array.isArray(args)) throw Object.assign(new Error('args 必须是字符串数组'), { status: 400 })
      return handlers.command({ cmd: body.cmd, args, wait: body.wait !== false })
    },
    'POST /v1/say': async (body) => {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 600) throw Object.assign(new Error('text 必须是 1 到 600 字'), { status: 400 })
      return handlers.say(body.text)
    },
    'POST /v1/ask': async (body) => {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 500) throw Object.assign(new Error('text 必须是 1 到 500 字'), { status: 400 })
      return handlers.ask(body.text)
    },
    'POST /v1/stop': async () => handlers.stop(),
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) return send(res, 403, { error: '不接受浏览器跨站请求' })
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'Host 不对' })
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '')
      if (!auth || !authorized(auth[1])) return send(res, 401, { error: '令牌不对' })
      if (!limit.take('api')) return send(res, 429, { error: '请求太频繁' })
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/v1/events') return stream(req, res)
      const m = /^\/v1\/workflows\/([a-z0-9][a-z0-9_-]{0,47})\/run$/.exec(url.pathname)
      if (req.method === 'POST' && m) { if (req.headers['content-type']) await readJSON(req); return send(res, 200, await handlers.runWorkflow(m[1])) }
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) return send(res, 404, { error: '没有这个接口' })
      const body = req.method === 'POST' ? await readJSON(req) : null
      send(res, 200, await route(body, url))
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : err.code === 'INVALID_ACTION' ? 400 : 500
      if (err.close) res.setHeader('Connection', 'close')
      send(res, status, { error: String(err.message || '出错了').slice(0, 300) })
      if (err.close) res.on('finish', () => req.socket.destroy())
      if (status === 500) log(`[agent] 处理请求出错: ${err.message}`)
    }
  })

  // Server-Sent Events：连上先补发最近 20 条，再实时推送；25 秒一个心跳
  function stream(req, res) {
    if (streams >= MAX_STREAMS) return send(res, 503, { error: '事件流连接太多' })
    streams++
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    const write = (e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    const since = Number(req.headers['last-event-id'] || 0)
    for (const e of events.since(Number.isSafeInteger(since) ? since : 0, 20)) write(e)
    const off = events.subscribe(write)
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
    beat.unref?.()
    req.on('close', () => { off(); clearInterval(beat); streams-- })
  }

  server.headersTimeout = 10_000
  server.requestTimeout = 11 * 60_000 // wait 的指令最长 10 分钟
  server.on('error', (err) => log(`[agent] Agent API 起不来: ${err.code || err.message}`))
  server.listen(port, host, () => log(`[agent] Agent API 在 http://${host.includes(':') ? `[${host}]` : host}:${port}/v1`))
  return { server, events, close: () => server.close() }
}

module.exports = { createAgentApi, createEventLog }
