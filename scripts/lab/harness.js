// 实机测试基座：通过显式 LAB_CONTAINER 和本机端口连接可丢弃的隔离测试服。
// 判定尽量走服务器侧真相（RCON 读坐标、背包、方块），不信机器人自己说的话。
const config = require('./config').loadLabConfig()
const mineflayer = require('mineflayer')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { setupFabric } = require('../../fabric')
const { createMods } = require('../../mods')

const LAB = config.container
const PORT = config.port
const NAME = 'LabBot'
const TESTER = 'Tester'
const ROOT = config.root
const EVIDENCE = config.outputDir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rcon(command) {
  const r = spawnSync('docker', config.rconArgs(command), { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) throw new Error(`RCON 失败: ${command}: ${r.stderr || r.stdout}`)
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim()
  // rcon-cli 对命令错误也可能返回 0，必须另外检查语法错误。
  if (/Incorrect argument|Unknown or incomplete command|Expected .*<--\[HERE\]/.test(out)) throw new Error(`RCON 命令错误: ${command}: ${out}`)
  return out
}

class Fail extends Error {}
const assert = (cond, msg) => { if (!cond) throw new Fail(msg) }

function createLab({ ai = false, fakeAI = false, viewDistance = 'short' } = {}) {
  const lab = { child: null, tester: null, chat: [], log: '', exits: [], ai }
  fs.mkdirSync(EVIDENCE, { recursive: true, mode: 0o700 })

  lab.startBot = async () => {
    const env = { ...process.env, MC_HOST: config.host, MC_PORT: String(PORT), MC_NAME: NAME, MC_VERSION: config.version, MC_VIEW: viewDistance }
    if (!ai) env.DEEPSEEK_API_KEY = fakeAI ? 'lab-placeholder-not-a-real-key' : ''
    const mark = lab.log.length
    lab.child = spawn(process.execPath, ['--max-old-space-size=256', ...(fakeAI ? ['--require', path.join(__dirname, 'fake-deepseek.js')] : []), 'bot.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const child = lab.child
    const onData = (s) => { lab.log += String(s) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code, signal) => { lab.exits.push({ code, signal, at: Date.now() }); if (lab.child === child) lab.child = null })
    const deadline = Date.now() + 40_000
    while (!lab.log.slice(mark).includes('[spawn]')) {
      if (Date.now() > deadline || !lab.child) throw new Error(`bot 没进服: ${lab.log.slice(mark).slice(-500)}`)
      await sleep(200)
    }
    await sleep(1000)
  }

  lab.startTester = async () => {
    const t = mineflayer.createBot({ host: config.host, port: PORT, username: TESTER, auth: 'offline', version: config.version, viewDistance: 'short' })
    const testerMods = createMods({ log: () => {} })
    setupFabric(t, { version: config.version, onRegistries: (ns) => { testerMods.activate(ns); return testerMods.componentCodecs() } })
    t.on('error', (err) => { lab.log += `[tester] ${err.message}\n` })
    t.on('chat', (u, text) => { if (u === NAME) lab.chat.push({ at: Date.now(), text }) })
    t.on('whisper', (u, text) => { if (u === NAME) lab.chat.push({ at: Date.now(), text }) })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tester 进服超时')), 40_000)
      t.once('spawn', () => { clearTimeout(timer); resolve() })
    })
    lab.tester = t
    await sleep(800)
  }

  lab.stop = async () => {
    lab.tester?.quit()
    if (lab.child) { lab.child.kill('SIGTERM'); await sleep(1500); if (lab.child) lab.child.kill('SIGKILL') }
  }

  // ---- 服务器侧读取 ----
  lab.pos = (who = NAME) => {
    const text = rcon(`data get entity ${who} Pos`)
    const c = text.match(/\[([^\]]+)\]/)?.[1].split(',').map((n) => Number(n.trim().replace(/[dDfF]$/, '')))
    if (!c?.every(Number.isFinite)) throw new Error(`读不到 ${who} 坐标: ${text}`)
    return { x: c[0], y: c[1], z: c[2] }
  }
  lab.count = (item, who = NAME) => {
    const text = rcon(`clear ${who} ${item} 0`)
    const m = text.match(/Found (\d+) matching/)
    return m ? Number(m[1]) : 0
  }
  lab.block = (x, y, z, spec) => /passed/i.test(rcon(`execute if block ${x} ${y} ${z} ${spec}`))
  lab.health = (who = NAME) => Number(rcon(`data get entity ${who} Health`).match(/([\d.]+)f?$/)?.[1])
  lab.setblock = (x, y, z, spec) => rcon(`setblock ${x} ${y} ${z} ${spec}`)
  lab.give = (item, n = 1, who = NAME) => rcon(`give ${who} ${item} ${n}`)
  // 只数场地附近的：全世界计数会把别处的算进来
  lab.near = (type, a, r = 32) => {
    const text = rcon(`execute positioned ${a.cx} 100 ${a.cz} if entity @e[type=${type},distance=..${r}]`)
    const m = text.match(/Count: (\d+)/)
    return m ? Number(m[1]) : 0
  }

  // ---- 场景工具 ----
  lab.reset = async () => {
    if (!lab.child) { await lab.startBot() }
    const stopAt = Date.now()
    lab.tester?.chat('bot stop')
    await sleep(800)
    // 聊天限速后回复可能排队：等上一场景的话说完，不然迟到的“停下了”会被下一场景当成结果
    if (lab.tester) await lab.waitChat(/停下了|正在降落/, 25_000, stopAt)
    for (const c of ['gamerule spawn_mobs false', `clear ${NAME}`, `clear ${TESTER}`, 'kill @e[type=item]', 'kill @e[type=!player]', 'time set 1000', 'weather clear',
      `effect clear ${NAME}`, `effect give ${NAME} minecraft:instant_health 1 5 true`, `effect give ${NAME} minecraft:saturation 3 10 true`,
      `gamemode survival ${NAME}`, `gamemode survival ${TESTER}`]) rcon(c)
    lab.mark = Date.now()
    await sleep(800)
    await lab.feed()
    // 共享背包模组可能把清掉的东西同步回来：清到服务器确认为空
    for (let i = 0; i < 5; i++) {
      const left = rcon(`clear ${NAME}`) + rcon(`clear ${TESTER}`)
      if (!/Removed/.test(left)) break
      await sleep(600)
    }
  }
  // 共享血量模组会把测试员的饥饿伤害同步给机器人；必要时让测试员进食。
  lab.feed = async () => {
    const t = lab.tester
    if (!t || t.food >= 14) return
    lab.give('minecraft:cooked_beef', 8, TESTER)
    await sleep(800)
    try {
      await t.equip(t.registry.itemsByName.cooked_beef.id, 'hand')
      for (let i = 0; i < 4 && t.food < 18; i++) await t.consume()
    } catch (err) { console.log(`[feed] ${err.message}`) }
    rcon(`clear ${TESTER}`)
  }
  // 平台竞技场：y=99 石头地板、上方清空。cx/cz 用分散坐标避免互相干扰。
  lab.arena = async (cx, cz, r = 16, { tester = true, floor = 'stone' } = {}) => {
    rcon('forceload remove all')
    rcon(`forceload add ${cx - r} ${cz - r} ${cx + r} ${cz + r}`)
    await sleep(1500)
    rcon(`fill ${cx - r} 90 ${cz - r} ${cx + r} 98 ${cz + r} minecraft:stone`)
    rcon(`fill ${cx - r} 99 ${cz - r} ${cx + r} 99 ${cz + r} minecraft:${floor}`)
    for (let y = 100; y < 124; y += 8) rcon(`fill ${cx - r} ${y} ${cz - r} ${cx + r} ${y + 7} ${cz + r} minecraft:air`)
    rcon(`tp ${NAME} ${cx + 0.5} 100 ${cz + 0.5}`)
    // Tester 默认站角落：共享血量下它被方块埋住/被怪打，机器人也一起掉血
    if (tester) rcon(`tp ${TESTER} ${cx - r + 1.5} 100 ${cz - r + 1.5}`)
    await sleep(3000)
    return { cx, cz, y: 100 }
  }
  lab.say = (msg) => { lab.tester.chat(msg) }
  lab.waitChat = async (re, ms = 30_000, since = lab.mark) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = lab.chat.find((m) => m.at >= since && re.test(m.text))
      if (hit) return hit.text
      if (!lab.child) throw new Fail('bot 进程在等待期间退出了')
      await sleep(150)
    }
    return null
  }
  // 发指令并等结果；返回 { text, ok, ms }。success / failure 都是聊天正则。
  lab.cmd = async (msg, success, failure = /$^/, ms = 60_000) => {
    const start = Date.now()
    lab.say(msg)
    const re = new RegExp(`${success.source}|${failure.source}`)
    const text = await lab.waitChat(re, ms, start)
    return { text, ok: !!text && success.test(text), ms: Date.now() - start }
  }
  lab.idle = async (ms = 30_000) => {
    const start = Date.now()
    lab.say('bot status')
    while (Date.now() - start < ms) {
      const t = lab.chat.filter((m) => m.at >= start && /任务:/.test(m.text)).at(-1)
      if (t && /任务: 空闲/.test(t.text)) return true
      await sleep(1500)
      lab.say('bot status')
    }
    return false
  }
  lab.chatSince = (t = lab.mark) => lab.chat.filter((m) => m.at >= t).map((m) => m.text)

  // ---- 运行一组场景，逐个落证据 ----
  lab.run = async (suite, scenarios, only) => {
    const results = []
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only?.length && !only.some((o) => name.includes(o))) continue
      await lab.reset().catch((err) => console.log(`[reset] ${err.message}`))
      const logMark = lab.log.length
      const started = Date.now()
      const res = { name, ok: false, trace: [] }
      // 服务器侧轨迹：每 1.5 秒记一次机器人坐标（查掉落、卡死、乱跑用）
      const tracer = setInterval(() => { try { const p = lab.pos(); res.trace.push([Math.round((Date.now() - started) / 1000), +p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), lab.health()]) } catch {} }, 1500)
      try {
        res.detail = await fn(lab)
        const died = lab.chatSince(started).some((t) => /我挂了/.test(t))
        if (died && !/死亡/.test(name)) throw new Fail('场景中机器人死亡了')
        res.ok = true
      } catch (err) {
        res.error = err.message
        res.harness = !(err instanceof Fail)
      }
      clearInterval(tracer)
      res.ms = Date.now() - started
      res.chat = lab.chatSince(started).slice(-40)
      res.log = lab.log.slice(logMark).split('\n').filter((l) => /\[(error|place|ledge|task:|mine|craft|mode|get|kicked|end|eat|combat|build|redstone|parkour|ai|replan|goal|fly|flight)|Error|Warning/.test(l)).slice(-30)
      res.exitsDuring = lab.exits.filter((e) => e.at >= started)
      if (process.env.LAB_RAW) res.raw = lab.log.slice(logMark).split('\n').slice(-80)
      results.push(res)
      console.log(`${res.ok ? 'PASS' : 'FAIL'} ${name} (${(res.ms / 1000).toFixed(1)}s)${res.error ? ' — ' + res.error : ''}`)
      fs.writeFileSync(path.join(EVIDENCE, `${suite}-latest.json`), JSON.stringify(results, null, 2), { mode: 0o600 })
    }
    const pass = results.filter((r) => r.ok).length
    console.log(`== ${suite}: ${pass}/${results.length} 通过 ==`)
    return results
  }
  return lab
}

module.exports = { createLab, rcon, assert, sleep, Fail, NAME, TESTER, LAB, PORT }
