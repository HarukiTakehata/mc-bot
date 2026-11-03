// 最小 RCON 客户端：只用来以控制台身份发打招呼特效（tellraw/title/particle）。
// 协议：int32LE 长度 + int32LE 请求号 + int32LE 类型 + ASCII/UTF-8 正文 + 两个 \0。3 = 登录，2 = 执行指令，0/2 = 回复。
// 边界：密码只从环境变量来、不进日志；单条指令和回复都限长；每一步都有超时；出错就断开，不重试。
const net = require('node:net')

const MAX_COMMAND = 1446 // 服务器端上限
const MAX_PACKET = 64 * 1024

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  return buf
}

// 一次连接执行一组指令，全部完成后断开
function rconRun({ host, port = 25575, password, timeoutMs = 5000 }, commands) {
  if (typeof password !== 'string' || !password) return Promise.reject(new Error('没有配置 RCON 密码'))
  for (const c of commands) if (typeof c !== 'string' || /[\r\n\0]/.test(c) || Buffer.byteLength(c) > MAX_COMMAND) return Promise.reject(new Error('RCON 指令为空、过长或含换行'))
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let buffer = Buffer.alloc(0)
    let nextId = 1
    let waiting = null
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      err ? reject(err) : resolve()
    }
    const timer = setTimeout(() => finish(new Error('RCON 超时')), timeoutMs * (commands.length + 1))
    const send = (type, body) => new Promise((ok) => { const id = nextId++; waiting = { id, ok }; socket.write(encode(id, type, body)) })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_PACKET) return finish(new Error('RCON 回复过大'))
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0)
        if (len < 10 || len > MAX_PACKET) return finish(new Error('RCON 回复格式不对'))
        if (buffer.length < len + 4) return
        const id = buffer.readInt32LE(4)
        buffer = buffer.subarray(len + 4)
        if (id === -1) return finish(new Error('RCON 密码不对'))
        if (waiting && id === waiting.id) { const w = waiting; waiting = null; w.ok() }
      }
    })
    socket.on('error', (err) => finish(new Error(`RCON 连不上: ${err.code || err.message}`)))
    socket.on('close', () => finish(new Error('RCON 连接被关闭')))
    socket.on('connect', async () => {
      try {
        await send(3, password)
        for (const c of commands) await send(2, c)
        finish()
      } catch (err) { finish(err) }
    })
  })
}

module.exports = { rconRun, encode, MAX_COMMAND }
