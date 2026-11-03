const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createAgentApi, createEventLog } = require('../agent-api')

const TOKEN = 'unit-test-token-0123456789abcdef'
function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function start(handlers = {}) {
  const port = 30000 + Math.floor(Math.random() * 20000)
  const calls = []
  const events = createEventLog()
  const api = createAgentApi({ port, token: TOKEN, events, log: () => {}, handlers: {
    state: () => ({ ok: 1 }), commands: () => ({}), workflows: () => [],
    command: async (x) => { calls.push(x); return { ok: true } }, say: (t) => { calls.push(t); return { ok: true } },
    ask: async () => ({ ok: true }), stop: () => ({ ok: true }), runWorkflow: async (id) => ({ id }), ...handlers,
  } })
  await new Promise((r) => api.server.once('listening', r))
  return { port, calls, events, close: () => api.close() }
}

test('令牌、浏览器 Origin、Host 头都要过关', async () => {
  const s = await start()
  try {
    assert.equal((await request(s.port, 'GET', '/v1/state')).status, 200)
    assert.equal((await request(s.port, 'GET', '/v1/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await request(s.port, 'GET', '/v1/state', { headers: { Authorization: '' } })).status, 401)
    assert.equal((await request(s.port, 'GET', '/v1/state', { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await request(s.port, 'GET', '/v1/state', { headers: { Host: 'evil.example' } })).status, 421)
    assert.equal((await request(s.port, 'GET', '/v1/nope')).status, 404)
  } finally { s.close() }
})

test('请求体：只收 JSON 对象、16KB 上限、参数类型校验', async () => {
  const s = await start()
  try {
    assert.equal((await request(s.port, 'POST', '/v1/command', { body: { cmd: 'pos' } })).status, 200)
    assert.deepEqual(s.calls[0], { cmd: 'pos', args: [], wait: true })
    assert.equal((await request(s.port, 'POST', '/v1/command', { body: { cmd: 'pos', args: 'x' } })).status, 400)
    assert.equal((await request(s.port, 'POST', '/v1/command', { body: '[1]' })).status, 400)
    assert.equal((await request(s.port, 'POST', '/v1/command', { body: 'x'.repeat(17000) })).status, 413)
    assert.equal((await request(s.port, 'POST', '/v1/say', { body: { text: 'x'.repeat(601) } })).status, 400)
    assert.equal((await request(s.port, 'POST', '/v1/workflows/Bad!/run')).status, 404)
    assert.deepEqual((await request(s.port, 'POST', '/v1/workflows/wood/run')).body, { id: 'wood' })
  } finally { s.close() }
})

test('处理函数抛出的校验错误变成 400，内部错误不泄露栈', async () => {
  const s = await start({ command: async () => { const e = new Error('指令参数数量不正确'); e.code = 'INVALID_ACTION'; throw e } })
  try {
    const r = await request(s.port, 'POST', '/v1/command', { body: { cmd: 'mine' } })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /参数数量/)
  } finally { s.close() }
})

test('事件：环形缓冲按 since 取增量', async () => {
  const s = await start()
  try {
    s.events.push('chat', { user: 'A', text: '1' })
    s.events.push('chat', { user: 'B', text: '2' })
    const all = (await request(s.port, 'GET', '/v1/events/recent')).body
    assert.equal(all.events.length, 2)
    const newer = (await request(s.port, 'GET', `/v1/events/recent?since=${all.events[0].id}`)).body
    assert.deepEqual(newer.events.map((e) => e.text), ['2'])
  } finally { s.close() }
})

test('令牌太短、端口不对直接拒绝启动', () => {
  assert.throws(() => createAgentApi({ port: 30001, token: 'short', handlers: {} }), /24/)
  assert.throws(() => createAgentApi({ port: 80, token: TOKEN, handlers: {} }), /1024/)
})

test('MCP：initialize、列工具、调用转发到 Agent API', async () => {
  const s = await start()
  process.env.MC_AGENT_TOKEN = TOKEN
  process.env.MC_AGENT_URL = `http://127.0.0.1:${s.port}/v1`
  delete require.cache[require.resolve('../scripts/mcp-server')]
  const { handle } = require('../scripts/mcp-server')
  const out = []
  const write = process.stdout.write
  process.stdout.write = function (line, ...rest) {
    // node --test 用 stdout 回报结果：只截 JSON-RPC 行，其他照常输出
    if (typeof line === 'string' && line.startsWith('{"jsonrpc"')) { out.push(JSON.parse(line)); return true }
    return write.call(this, line, ...rest)
  }
  try {
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'minecraft_command', arguments: { cmd: 'pos' } } })
    await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'minecraft_run_workflow', arguments: { name: '../x' } } })
    await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })
  } finally { process.stdout.write = write; s.close() }
  assert.equal(out[0].result.serverInfo.name, 'mc-bot')
  assert.equal(out.length, 5, '通知不回复')
  assert.ok(out[1].result.tools.some((t) => t.name === 'minecraft_state') && out[1].result.tools.every((t) => !t.call))
  assert.match(out[2].result.content[0].text, /"ok": true/)
  assert.deepEqual(s.calls[0], { cmd: 'pos', args: [], wait: true })
  assert.equal(out[3].result.isError, true)
  assert.equal(out[4].error.code, -32601)
})
