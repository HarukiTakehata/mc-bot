// 仅用于本次创建的独立空世界，固定loopback端口/容器，绝不访问生产服。
const mineflayer = require('mineflayer')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createFlight } = require('../flight')
const { createRuntime, CancelledError } = require('../runtime')
const { installProtocolCompat } = require('../protocol-compat')
const { finishFlightRoute } = require('../flight-route')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const LAB = 'luomo-mcbot-elytra-lab-20261030'
const NAME = 'FlyLabBot'
const mode = process.argv[2] || 'arrival'
if (!['arrival', 'stop', 'reject', 'roundtrip'].includes(mode)) throw new Error('Expected arrival, stop, reject or roundtrip')
const out = process.env.FLIGHT_TEST_OUTPUT || '/tmp/mcbot-flight-evidence'
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const report = { case: mode, startedAt: new Date().toISOString(), traces: [], phases: [], commands: [] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function rcon(command) {
  const result = spawnSync('docker', ['exec', LAB, 'rcon-cli', '--config', '/data/.rcon-cli.yaml', command], { encoding: 'utf8', timeout: 20_000 })
  if (result.status !== 0) throw new Error('Lab RCON failed: ' + (result.stderr || result.stdout))
  const output = result.stdout.trim()
  report.commands.push({ command, output })
  return output
}
let bot, engine, runtime, watchdog
async function run() {
  const other = rcon('list')
  if (!/0 of a max/.test(other)) throw new Error('Isolated lab already has a player; refusing to alter it')
  rcon('forceload remove all')
  rcon('forceload add -64 -32 447 63')
  await sleep(2500)
  for (const command of [...Array.from({ length: 8 }, (_, n) => `fill ${-64 + n * 64} 63 -32 ${-1 + n * 64} 63 63 minecraft:stone`), 'time set day', 'weather clear']) {
    const output = rcon(command)
    if (/not loaded|too many|error|unknown/i.test(output)) throw new Error(output)
  }
  bot = mineflayer.createBot({ host: '127.0.0.1', port: 25576, username: NAME, auth: 'offline', version: '26.1', viewDistance: 'normal' })
  bot.loadPlugin(pathfinder)
  bot.on('error', (err) => { report.error = err.message })
  bot.on('kicked', (why) => { report.kicked = why; engine?.dispose('kicked') })
  bot.on('end', (why) => { report.end = why; engine?.dispose('disconnected') })
  let spawnTimer
  try {
    await Promise.race([new Promise((resolve) => bot.once('spawn', resolve)), new Promise((_, reject) => { spawnTimer = setTimeout(() => reject(new Error('lab spawn timeout')), 25_000) })])
  } finally { clearTimeout(spawnTimer) }
  rcon(`tp ${NAME} 0.5 64 0.5`)
  rcon(`clear ${NAME}`)
  rcon(`item replace entity ${NAME} armor.chest with minecraft:elytra`)
  rcon(`give ${NAME} minecraft:firework_rocket[minecraft:fireworks={flight_duration:1,explosions:[]}] 32`)
  await sleep(1500)
  runtime = createRuntime({ timeoutMs: 110_000, onTimeout: () => engine.requestLand('lab_runtime_timeout') })
  installProtocolCompat(bot)
  runtime.guardBot(bot)
  const safeMoves = new Movements(bot)
  safeMoves.canDig = false; safeMoves.allow1by1towers = false; safeMoves.scafoldingBlocks = []
  safeMoves.exclusionAreasPlace.push(() => Infinity)
  bot.pathfinder.setMovements(safeMoves)
  engine = createFlight(bot, {
    assertActive: runtime.assertActive, delay: runtime.delay, safetyDelay: sleep,
    safetyLook: (yaw, pitch) => { if (engine.active() && engine.status().phase === 'LANDING') return runtime.unscoped(() => bot.look(yaw, pitch, true)) },
    safetyGlide: () => { if (engine.active() && engine.status().phase === 'LANDING') return runtime.unscoped(() => bot.elytraFly()) },
    log: (...args) => { report.phases.push({ elapsed: Date.now() - report.startMs, text: args.join(' ') }); console.log(...args) },
  })
  report.startMs = Date.now()
  report.before = { health: bot.health, food: bot.food, position: { ...bot.entity.position }, rockets: bot.inventory.items().filter((i) => i.name === 'firework_rocket').reduce((n, i) => n + i.count, 0) }
  let tick = 0, stopSent = false
  bot.on('physicsTick', () => {
    if (tick++ % 5 === 0) report.traces.push({ elapsed: Date.now() - report.startMs, phase: engine.status().phase,
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
      vx: bot.entity.velocity.x, vy: bot.entity.velocity.y, vz: bot.entity.velocity.z,
      onGround: bot.entity.onGround, flying: bot.entity.elytraFlying, health: bot.health, rockets: bot.inventory.items().filter((i) => i.name === 'firework_rocket').reduce((n, i) => n + i.count, 0) })
    if (mode === 'stop' && !stopSent && bot.entity.elytraFlying && engine.status().rocketsUsed >= 1 && Date.now() - report.startMs > 800) {
      stopSent = true; report.stopAt = Date.now() - report.startMs
      report.rocketsAtStop = engine.status().rocketsUsed
      engine.requestLand('lab_stop'); runtime.cancel()
    }
  })
  watchdog = setTimeout(() => { report.deadline = true; engine.dispose('lab_test_deadline') }, 100_000)
  if (mode === 'reject') {
    rcon(`item replace entity ${NAME} armor.chest with minecraft:diamond_chestplate`)
    await sleep(400)
  }
  try {
    const flyRoute = async (target) => {
      const leg = await engine.fly(target)
      // 停止案例保留落地证据；不在已取消上下文启动末段步行。
      if (!runtime.isActive()) return leg
      return finishFlightRoute(bot, target, leg, {
        assertActive: runtime.assertActive,
        walk: (p) => bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 1)),
        say: (text) => report.phases.push({ text }),
      })
    }
    await runtime.runTask('live-flight', async () => { report.result = await flyRoute({ x: mode === 'roundtrip' ? 300.5 : 80.5, y: 64, z: 0.5 }) })
    if (mode === 'roundtrip' && report.result.ok) {
      report.outboundServerPosition = rcon(`data get entity ${NAME} Pos`)
      await runtime.runTask('return-flight', async () => { report.returnResult = await flyRoute({ x: 0.5, y: 64, z: 0.5 }) })
    }
  } catch (err) {
    report.operationError = { name: err.name, message: err.message }
    if (!(err instanceof CancelledError) && mode !== 'reject') throw err
  }
  report.after = { health: bot.health, food: bot.food, position: { ...bot.entity.position },
    serverPosition: rcon(`data get entity ${NAME} Pos`), serverHealth: rcon(`data get entity ${NAME} Health`) }
  report.ok = mode === 'arrival' || mode === 'roundtrip' ? !!(report.result?.ok && report.result?.landed && (mode !== 'roundtrip' || report.returnResult?.ok) && report.after.health >= report.before.health)
    : mode === 'stop' ? !!(stopSent && report.result?.landed && !report.result?.ok && report.result?.rocketsUsed === report.rocketsAtStop && report.after.health >= report.before.health)
      : !!(report.operationError && !report.result && bot.entity.onGround && bot.inventory.items().filter((i) => i.name === 'firework_rocket').reduce((n, i) => n + i.count, 0) === report.before.rockets)
}
run().catch((err) => { report.error = err.message; report.ok = false }).finally(async () => {
  clearTimeout(watchdog)
  engine?.dispose('test_complete')
  if (bot) { bot.quit(); await sleep(300) }
  delete report.startMs
  const file = path.join(out, `flight-${mode}-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.ok, case: mode, result: report.result, returnResult: report.returnResult, before: report.before, after: report.after, error: report.error, evidence: file }))
  process.exitCode = report.ok ? 0 : 1
})
