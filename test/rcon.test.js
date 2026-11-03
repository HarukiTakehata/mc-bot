const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { rconRun, encode } = require('../rcon')
const { consoleFrom, greetingCommands } = require('../greet')

// 假 RCON 服务器：记录收到的指令，密码不对回 -1
function fakeServer(password) {
  const received = []
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
        const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8)
        const body = buf.subarray(12, len + 2).toString('utf8')
        buf = buf.subarray(len + 4)
        if (type === 3) socket.write(encode(body === password ? id : -1, 2, ''))
        else { received.push(body); socket.write(encode(id, 0, '')) }
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })))
}

test('RCON：登录后按顺序执行，全部完成才返回', async () => {
  const { server, received, port } = await fakeServer('pw')
  try {
    await rconRun({ host: '127.0.0.1', port, password: 'pw' }, ['say 1', 'tellraw Steve "你好"'])
    assert.deepEqual(received, ['say 1', 'tellraw Steve "你好"'])
  } finally { server.close() }
})

test('RCON：密码错、连不上、指令越界都明确失败', async () => {
  const { server, received, port } = await fakeServer('pw')
  try {
    await assert.rejects(rconRun({ host: '127.0.0.1', port, password: 'nope' }, ['say 1']), /密码不对/)
    assert.deepEqual(received, [])
    await assert.rejects(rconRun({ host: '127.0.0.1', port, password: 'pw' }, ['say 1\nop x']), /换行/)
    await assert.rejects(rconRun({ host: '127.0.0.1', port, password: 'pw' }, ['x'.repeat(1447)]), /过长/)
    await assert.rejects(rconRun({ host: '127.0.0.1', port, password: '' }, ['say 1']), /密码/)
  } finally { server.close() }
  await assert.rejects(rconRun({ host: '127.0.0.1', port, password: 'pw', timeoutMs: 500 }, ['say 1']), /连不上|关闭/)
})

test('控制台选择：没配就只用 /msg；端口不合法直接报错', () => {
  assert.equal(consoleFrom({}), null)
  assert.equal(typeof consoleFrom({ MC_RCON_PASSWORD: 'x' }), 'function')
  assert.equal(typeof consoleFrom({ MC_CTL: '/path/to/ctl.py' }), 'function')
  assert.throws(() => consoleFrom({ MC_RCON_PASSWORD: 'x', MC_RCON_PORT: '70000' }), /端口/)
})

test('欢迎语不再写死服务器名；名字不合格就不写', () => {
  const plain = greetingCommands('Steve', 'Bot', { hour: 9 }).join('\n')
  assert.ok(!plain.includes('Luomo') && plain.includes('欢迎回来'))
  assert.ok(greetingCommands('Steve', 'Bot', { serverName: '我的服' }).join('').includes('"我的"'))
  assert.ok(!greetingCommands('Steve', 'Bot', { serverName: '坏\n名字' }).join('').includes('坏'))
})
