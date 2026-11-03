const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createMods, validate, LIMITS } = require('../mods')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-mods-'))
const quiet = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')) } }
const write = (dir, name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))

test('内置扩展全部合法，读的时候不报任何问题', () => {
  const { lines, log } = quiet()
  const mods = createMods({ userDir: tmp(), log })
  assert.deepEqual(lines, [])
  assert.ok(mods.all().length >= 9)
  for (const d of mods.all()) assert.ok(d.builtin)
})

test('auto 按注册表命名空间启用；manual 只能点名；disable 优先', () => {
  const mods = createMods({ userDir: tmp(), enable: 'shared-world', disable: 'lootr', log: () => {} })
  const ids = mods.activate(new Set(['refinedstorage', 'lootr', 'somethingelse'])).map((d) => d.id)
  assert.deepEqual(ids.sort(), ['refinedstorage', 'shared-world'])
  assert.equal(mods.features().sharedInventory, true)
  // 只启用一次：之后再调用不改变结果
  assert.deepEqual(mods.activate(new Set(['waystones'])).map((d) => d.id).sort(), ids)
})

test('原版/Paper 服没有注册表：只启用 always 和点名的，不会误开共享规则', () => {
  const mods = createMods({ userDir: tmp(), log: () => {} })
  assert.deepEqual(mods.activate(null), [])
  assert.deepEqual(mods.features(), { sharedInventory: false, sharedHealth: false })
  assert.equal(mods.promptNotes(), '')
  assert.equal(mods.componentCodecs().size, 0)
})

test('共享规则只在开启时写进 AI 提示', () => {
  const on = createMods({ userDir: tmp(), enable: 'shared-world', log: () => {} })
  on.activate(null)
  assert.match(on.promptNotes(), /共享背包、共享血量/)
})

test('组件编码：只能声明自己命名空间、只能用允许的类型', () => {
  const base = { id: 'x', namespaces: ['foo'] }
  assert.equal(validate({ ...base, components: { 'foo:energy': 'varlong' } }).components.get('foo:energy'), 'varlong')
  assert.throws(() => validate({ ...base, components: { 'minecraft:damage': 'varint' } }), /namespaces/)
  assert.throws(() => validate({ ...base, components: { 'bar:energy': 'varint' } }), /namespaces/)
  assert.throws(() => validate({ ...base, components: { 'foo:x': 'Slot' } }), /允许列表/)
  assert.throws(() => validate({ ...base, components: { 'foo:x': 'restBuffer' } }), /允许列表/)
  assert.throws(() => validate({ id: 'x', namespaces: ['minecraft'] }), /minecraft/)
})

test('拒绝不认识的字段、坏 id、越界文本，json 里不能有 setup', () => {
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], tipz: [] }), /不认识的字段 tipz/)
  assert.throws(() => validate({ id: 'X Y', namespaces: ['a'] }), /id/)
  assert.throws(() => validate({ id: 'x' }), /auto 扩展必须写 namespaces/)
  assert.throws(() => validate({ id: 'x', activate: 'sometimes', namespaces: ['a'] }), /activate/)
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], prompt: 'a'.repeat(LIMITS.prompt + 1) }), /prompt/)
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], prompt: '换行\n注入' }), /单行/)
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], tips: [{ keys: [], text: 'a' }] }), /keys/)
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], features: { op: true } }), /features/)
  assert.throws(() => validate({ id: 'x', namespaces: ['a'], setup() {} }), /只有 .js/)
  assert.throws(() => validate(JSON.parse('{"id":"x","namespaces":["a"],"__proto__":{"activate":"always"}}')), /不认识的字段 __proto__/)
})

test('读目录：坏文件只跳过自己；符号链接、超大文件不读；用户扩展可覆盖内置', () => {
  const builtin = tmp(), user = tmp(), outside = tmp()
  write(builtin, 'foo.json', { id: 'foo', namespaces: ['foo'], tips: [{ keys: ['foo'], text: '内置' }] })
  write(user, 'foo.json', { id: 'foo', namespaces: ['foo'], tips: [{ keys: ['foo'], text: '覆盖' }] })
  write(user, 'broken.json', '{ not json')
  write(user, 'big.json', JSON.stringify({ id: 'big', namespaces: ['big'], name: 'x' }).padEnd(LIMITS.fileBytes + 10, ' '))
  write(outside, 'evil.json', { id: 'evil', activate: 'always' })
  fs.symlinkSync(path.join(outside, 'evil.json'), path.join(user, 'evil.json'))
  write(user, 'dup.json', { id: 'foo2', namespaces: ['foo'] })
  write(user, 'dup2.json', { id: 'foo2', namespaces: ['foo'] })
  write(user, 'README.md', 'ignored')
  const { lines, log } = quiet()
  const mods = createMods({ builtinDir: builtin, userDir: user, log })
  const ids = mods.all().map((d) => d.id).sort()
  assert.deepEqual(ids, ['foo', 'foo2'])
  assert.equal(mods.all().find((d) => d.id === 'foo').tips[0].text, '覆盖')
  for (const re of [/跳过 broken.json/, /跳过 big.json/, /跳过 evil.json.*符号链接/, /覆盖内置扩展 foo/, /dup2.json: id foo2 重复/]) assert.ok(lines.some((l) => re.test(l)), re)
})

test('两个扩展给同一组件不同编码：两个都不用', () => {
  const defs = [validate({ id: 'a', namespaces: ['m'], components: { 'm:e': 'varint' } }), validate({ id: 'b', namespaces: ['m'], components: { 'm:e': 'varlong' } })]
  const { lines, log } = quiet()
  const mods = createMods({ defs, log })
  mods.activate(new Set(['m']))
  assert.equal(mods.componentCodecs().has('m:e'), false)
  assert.ok(lines.some((l) => /编码不同/.test(l)))
})

test('.js 扩展：注册指令、监听事件；出错只记日志，反复出错自动停掉监听', () => {
  const bot = new EventEmitter()
  const registered = new Map()
  let calls = 0
  const def = validate({
    id: 'demo', activate: 'always',
    setup(api) {
      api.command('hello', { help: '打招呼', read: true, run: () => 'hi' })
      assert.throws(() => api.command('Bad-Name', { run() {} }), /小写字母/)
      api.on('tick', () => { calls++; throw new Error('boom') })
    },
  }, { code: true })
  const { lines, log } = quiet()
  const mods = createMods({ defs: [def], log })
  mods.activate(null)
  mods.setupAll({ bot, registerCommand: (name, spec) => registered.set(name, spec), ctx: { say() {}, sleepMs() {} } })
  assert.equal(registered.get('hello').read, true)
  assert.equal(registered.get('hello').id, 'demo')
  for (let i = 0; i < 25; i++) bot.emit('tick')
  assert.equal(calls, LIMITS.errors)
  assert.equal(bot.listenerCount('tick'), 0)
  assert.ok(lines.some((l) => /已停用它的事件监听/.test(l)))
})

test('setup 自己抛错不影响别的扩展', () => {
  const ok = []
  const defs = [
    validate({ id: 'bad', activate: 'always', setup() { throw new Error('坏了') } }, { code: true }),
    validate({ id: 'good', activate: 'always', setup() { ok.push(1) } }, { code: true }),
  ]
  const { lines, log } = quiet()
  const mods = createMods({ defs, log })
  mods.activate(null)
  mods.setupAll({ bot: new EventEmitter(), registerCommand() {}, ctx: {} })
  assert.deepEqual(ok, [1])
  assert.ok(lines.some((l) => /\[mods:bad\] setup 出错: 坏了/.test(l)))
})
