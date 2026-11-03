const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { loadLabConfig } = require('../scripts/lab/config')

// Load the real harness with inert dependencies: no Docker, game server or files are changed.
function loadRcon(result) {
  const calls = []
  const config = loadLabConfig({ LAB_CONTAINER: 'mc-bot-test', LAB_RCON_CONFIG: '/test/rcon.yaml' })
  const dependencies = {
    './config': { loadLabConfig: () => config },
    mineflayer: {},
    'node:child_process': { spawnSync: (...args) => { calls.push(args); return result } },
    'node:fs': {},
    'node:path': path,
    '../../fabric': {},
    '../../mods': {},
  }
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
  }
  const filename = path.join(__dirname, '../scripts/lab/harness.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return { rcon: context.module.exports.rcon, calls, config }
}

test('lab RCON reports missing Docker with installation and PATH guidance', () => {
  const error = Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' })
  const { rcon } = loadRcon({ status: null, error })
  assert.throws(() => rcon('list'), (err) => {
    assert.match(err.message, /docker.*ENOENT/)
    assert.match(err.message, /安装 Docker CLI.*PATH/)
    assert.doesNotMatch(err.message, /undefined/)
    assert.equal(err.cause, error)
    return true
  })
})

for (const code of ['EACCES', 'ETIMEDOUT']) {
  test(`lab RCON preserves ${code} spawn failures`, () => {
    const error = Object.assign(new Error(`spawnSync docker ${code}`), { code })
    const { rcon } = loadRcon({ status: null, stderr: 'partial output', error })
    assert.throws(() => rcon('list'), (err) => {
      assert.ok(err.message.includes(code))
      assert.equal(err.cause, error)
      assert.doesNotMatch(err.message, /安装 Docker CLI/)
      return true
    })
  })
}

test('lab RCON preserves nonzero Docker stderr and stdout diagnostics', () => {
  for (const result of [
    { status: 1, stderr: 'No such container: mc-bot-test', stdout: '' },
    { status: 1, stderr: '', stdout: 'RCON connection refused' },
  ]) {
    assert.throws(() => loadRcon(result).rcon('list'), (err) => {
      assert.ok(err.message.includes(result.stderr || result.stdout))
      return true
    })
  }
})

test('lab RCON reports exit status or signal when output is empty', () => {
  assert.throws(() => loadRcon({ status: 1, stderr: '', stdout: '' }).rcon('list'), /exit status=1/)
  assert.throws(() => loadRcon({ status: null, signal: 'SIGTERM' }).rcon('list'), /signal=SIGTERM/)
})

test('lab RCON preserves successful output cleanup and Docker arguments', () => {
  const { rcon, calls, config } = loadRcon({ status: 0, stdout: '\u001b[32mThere are 0 players\u001b[0m\n' })
  assert.equal(rcon('list'), 'There are 0 players')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'docker')
  assert.deepEqual(calls[0][1], config.rconArgs('list'))
  assert.equal(calls[0][2].encoding, 'utf8')
  assert.equal(calls[0][2].timeout, 30_000)
})

test('lab RCON still rejects command errors with successful exit status', () => {
  for (const stdout of ['Incorrect argument', 'Unknown or incomplete command', 'Expected integer <--[HERE]']) {
    assert.throws(() => loadRcon({ status: 0, stdout }).rcon('bad command'), /RCON 命令错误/)
  }
})
