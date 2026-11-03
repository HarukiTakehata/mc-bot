const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadConfig } = require('../config')

const file = (obj) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json'); fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p }

test('config.json 补上没设的环境变量，已设的不覆盖', () => {
  const env = { MC_HOST: 'from-env' }
  const applied = loadConfig({ file: file({ $comment: '注释', server: { host: 'x', port: 25566, username: 'Bot_1' }, ai: { provider: 'openai', jsonMode: false }, mods: { enable: ['shared-world'] }, chat: { prefixes: ['cb', '小助手'] } }), env })
  assert.equal(env.MC_HOST, 'from-env')
  assert.equal(env.MC_PORT, '25566')
  assert.equal(env.AI_PROVIDER, 'openai')
  assert.equal(env.AI_JSON_MODE, 'off')
  assert.equal(env.MC_MODS, 'shared-world')
  assert.equal(env.MC_PREFIX, 'cb,小助手')
  assert.ok(!applied.includes('server.host'))
})

test('没有文件就什么都不做；密钥、未知键、类型错误都报错', () => {
  assert.deepEqual(loadConfig({ file: '/nonexistent/config.json', env: {} }), [])
  for (const [obj, re] of [
    [{ ai: { apiKey: 'sk-1' } }, /密钥只能放 .env/],
    [{ greet: { rconPassword: 'x' } }, /密钥/],
    [{ agent: { token: 'x' } }, /密钥/],
    [{ server: { hots: 'x' } }, /不认识的设置 server.hots/],
    [{ server: { port: '25565' } }, /server.port/],
    [{ server: { port: 70000 } }, /server.port/],
    [{ ai: { provider: 'gpt' } }, /ai.provider/],
    [{ chat: { prefixes: ['a b'] } }, /chat.prefixes/],
    ['{nope', /不是合法 JSON/],
    ['[]', /顶层必须是对象/],
  ]) assert.throws(() => loadConfig({ file: file(obj), env: {} }), re)
})
