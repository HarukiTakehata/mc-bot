// 独立空世界中的两个测试客户端验证真实聊天→指令→行为，不读取.env。
const mineflayer = require('mineflayer')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const LAB = 'luomo-mcbot-elytra-lab-20261030', NAME = 'CompanionLabBot', OWNER = 'FollowLabOwner'
const report = { startedAt: new Date().toISOString(), checks: [], messages: [], commands: [], botLog: '' }
const out = process.env.FLIGHT_TEST_OUTPUT || '/tmp/mcbot-flight-evidence'
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function rcon(command) {
  const r = spawnSync('docker', ['exec', LAB, 'rcon-cli', '--config', '/data/.rcon-cli.yaml', command], { encoding: 'utf8', timeout: 15_000 })
  if (r.status !== 0) throw new Error('Lab RCON failed')
  report.commands.push({ command, output: r.stdout.trim() })
  return r.stdout.trim()
}
function pos() {
  const text = rcon(`data get entity ${NAME} Pos`)
  const coords = text.match(/\[([^\]]+)\]/)?.[1].split(',').map((n) => Number(n.trim().replace(/[dDfF]$/, '')))
  if (!coords?.every(Number.isFinite)) throw new Error('Cannot read companion position')
  return { x: coords[0], y: coords[1], z: coords[2] }
}
async function until(fn, ms = 12_000) {
  const until = Date.now() + ms
  while (!fn()) { if (Date.now() > until) throw new Error('Timed out waiting for companion behavior'); await sleep(200) }
}
let child, owner
async function connectOwner() {
  const b = mineflayer.createBot({ host: '127.0.0.1', port: 25576, username: OWNER, auth: 'offline', version: '26.1' })
  b.on('chat', (u, text) => { if (u === NAME) report.messages.push(text) })
  b.on('error', (err) => { report.ownerError = err.message })
  let timer
  try { await Promise.race([new Promise((r) => b.once('spawn', r)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owner spawn timeout')), 20_000) })]) }
  finally { clearTimeout(timer) }
  return b
}
async function run() {
  if (!/0 of a max/.test(rcon('list'))) throw new Error('Isolated lab is occupied; refusing test')
  child = spawn(process.execPath, ['--max-old-space-size=256', path.resolve(__dirname, '../bot.js')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: '25576', MC_NAME: NAME, MC_VERSION: '26.1', DEEPSEEK_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (s) => { report.botLog += String(s) })
  child.stderr.on('data', (s) => { report.botLog += String(s) })
  await until(() => report.botLog.includes('[spawn]'), 25_000)
  rcon(`tp ${NAME} 0.5 64 0.5`)
  owner = await connectOwner(); rcon(`tp ${OWNER} 16.5 64 0.5`); await sleep(1200)
  owner.chat('bot follow 4')
  await until(() => { const p = pos(); return Math.abs(p.x - 16.5) <= 6 && p.x > 8 })
  report.checks.push({ name: 'follow_distance', position: pos() })
  owner.quit(); owner = null; await sleep(1800)
  const lost = pos(); await sleep(2400); const waiting = pos()
  if (Math.hypot(waiting.x - lost.x, waiting.z - lost.z) > 0.7) throw new Error('Lost follow target did not wait')
  report.checks.push({ name: 'lost_target_waiting', from: lost, to: waiting })
  owner = await connectOwner(); rcon(`tp ${OWNER} 34.5 64 0.5`); await sleep(1000)
  await until(() => pos().x > 27)
  report.checks.push({ name: 'reacquired_new_entity', position: pos() })
  owner.chat('bot scan'); await sleep(400); owner.chat('bot advice'); await sleep(600)
  if (!report.messages.some((m) => m.includes('位置:')) || !report.messages.some((m) => /储备|补给|缺镐/.test(m))) throw new Error('Read-only observation/advice missing from real chat')
  report.checks.push({ name: 'real_chat_scan_advice', messages: report.messages.slice(-6) })
  owner.chat('bot stop'); await sleep(600)
  const stopped = pos(); rcon(`tp ${OWNER} 52.5 64 0.5`); await sleep(2500)
  const after = pos()
  if (Math.hypot(after.x - stopped.x, after.z - stopped.z) > 0.7) throw new Error('Follow resumed after stop')
  report.checks.push({ name: 'stop_does_not_resume', from: stopped, to: after })
  report.ok = true
}
run().catch((err) => { report.ok = false; report.error = err.message }).finally(async () => {
  owner?.quit()
  child?.kill('SIGTERM')
  await sleep(600)
  if (child && child.exitCode === null) child.kill('SIGKILL')
  const file = path.join(out, `companion-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks, error: report.error, evidence: file }))
  process.exitCode = report.ok ? 0 : 1
})
