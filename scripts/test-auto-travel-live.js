// 固定连接本聊天创建的独立空世界；从代码副本运行，隔离所有data和AI历史。
const mineflayer = require('mineflayer')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.LAB_OUT || path.join(ROOT, 'logs', 'auto-travel-live')
const LAB = 'luomo-mcbot-elytra-lab-20261030', NAME = 'AutoLabBot', OWNER = 'AutoLabOwner'
const real = process.argv.includes('--real-ai')
const selected = process.argv.filter((s) => s.startsWith('--case=')).map((s) => s.slice(7))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { mode: real ? 'real' : 'fake', startedAt: new Date().toISOString(), results: [], messages: [], log: '', commands: [] }
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 })
const sandbox = path.join(OUT, `sandbox-${real ? 'real' : 'fake'}-${Date.now()}`)
fs.mkdirSync(sandbox, { mode: 0o700 })
for (const file of fs.readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue
  const source = path.join(file.parentPath, file.name), rel = path.relative(ROOT, source)
  if (rel.split(path.sep).some((p) => ['node_modules', 'data', 'logs', '.git'].includes(p)) || file.name.startsWith('.env') || file.name.endsWith('.log') || file.name === '.DS_Store') continue
  const dest = path.join(sandbox, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest)
}
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(sandbox, 'node_modules'))
fs.mkdirSync(path.join(sandbox, 'data'), { mode: 0o700 })
fs.writeFileSync(path.join(sandbox, 'data/places.json'), JSON.stringify({ 营地: { x: 300.5, y: 64, z: 0.5, dim: 'overworld' } }), { mode: 0o600 })
const trace = path.join(OUT, `ai-travel-${real ? 'real' : 'fake'}-${Date.now()}.jsonl`)
if (real) process.loadEnvFile(path.join(ROOT, '.env'))
function rcon(command) {
  const r = spawnSync('docker', ['exec', LAB, 'rcon-cli', '--config', '/data/.rcon-cli.yaml', command], { encoding: 'utf8', timeout: 20_000 })
  if (r.status !== 0) throw new Error('隔离实验RCON不可用')
  const text = r.stdout.trim(); report.commands.push({ command, text })
  if (/Incorrect argument|Unknown or incomplete command|Expected .*<--\[HERE\]|Too many blocks|not loaded|Cannot place blocks/i.test(text)) throw new Error(text)
  return text
}
const position = () => {
  const text = rcon(`data get entity ${NAME} Pos`), c = text.match(/\[([^\]]+)\]/)?.[1].split(',').map((s) => Number(s.trim().replace(/[dDfF]$/, '')))
  if (!c?.every(Number.isFinite)) throw new Error('实验服位置读回无效')
  return { x: c[0], y: c[1], z: c[2] }
}
const rockets = () => Number(rcon(`clear ${NAME} minecraft:firework_rocket 0`).match(/Found (\d+) matching/)?.[1] || 0)
const health = () => Number(rcon(`data get entity ${NAME} Health`).match(/([\d.]+)f?$/)?.[1])
const inventory = () => rcon(`data get entity ${NAME} Inventory`)
const equipment = () => rcon(`data get entity ${NAME} equipment`)
let child, owner
async function until(fn, ms = 30_000) {
  const deadline = Date.now() + ms
  while (!fn()) { if (Date.now() > deadline) throw new Error('实验等待超时'); if (child && child.exitCode !== null) throw new Error('实验机器人退出'); await sleep(150) }
}
async function start() {
  if (!/0 of a max/.test(rcon('list'))) throw new Error('本聊天隔离世界有其他玩家，拒绝重置')
  rcon('forceload remove all'); rcon('forceload add -64 -32 447 63'); await sleep(2500)
  for (let n = 0; n < 8; n++) rcon(`fill ${-64 + n * 64} 63 -32 ${-1 + n * 64} 63 63 minecraft:stone`)
  rcon('time set day'); rcon('weather clear')
  if (real && !process.env.DEEPSEEK_API_KEY) throw new Error('未配置已有DeepSeek密钥')
  child = spawn(process.execPath, ['--max-old-space-size=256', '--require', path.join(sandbox, 'scripts/lab/auto-travel-ai.js'), path.join(sandbox, 'bot.js')], {
    cwd: sandbox, env: { ...process.env, MC_HOST: '127.0.0.1', MC_PORT: '25576', MC_VERSION: '26.1', MC_VIEW: 'normal', MC_NAME: NAME,
      DEEPSEEK_API_KEY: real ? process.env.DEEPSEEK_API_KEY : 'isolated-placeholder', LAB_TRAVEL_AI_MODE: real ? 'real' : 'fake', LAB_TRAVEL_AI_TRACE: trace },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (s) => { report.log += String(s) }); child.stderr.on('data', (s) => { report.log += String(s) })
  await until(() => report.log.includes('[spawn]'))
  owner = mineflayer.createBot({ host: '127.0.0.1', port: 25576, username: OWNER, version: '26.1', auth: 'offline' })
  owner.on('chat', (user, text) => { if (user === NAME) report.messages.push({ at: Date.now(), text }) })
  owner.on('error', (err) => { report.ownerError = err.message })
  let timer
  try { await Promise.race([new Promise((r) => owner.once('spawn', r)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('实验玩家进服超时')), 30_000) })]) }
  finally { clearTimeout(timer) }
  rcon(`gamemode creative ${OWNER}`); rcon(`tp ${OWNER} 0.5 66 6.5`)
}
async function reset(kit) {
  owner.chat('bot stop'); await sleep(800)
  rcon(`tp ${NAME} 0.5 64 0.5`); rcon(`clear ${NAME}`); rcon(`effect clear ${NAME}`)
  rcon(`effect give ${NAME} minecraft:instant_health 1 5 true`); rcon(`effect give ${NAME} minecraft:saturation 1 5 true`)
  for (let y = 67; y <= 85; y += 8) rcon(`fill -8 ${y} -8 145 ${Math.min(85, y + 7)} 8 minecraft:air`)
  if (kit === 'armor') { rcon(`item replace entity ${NAME} armor.chest with minecraft:iron_chestplate`); rcon(`give ${NAME} minecraft:elytra 1`) }
  else if (kit === 'inventory') { rcon(`item replace entity ${NAME} armor.chest with minecraft:air`); rcon(`give ${NAME} minecraft:elytra 1`) }
  else rcon(`item replace entity ${NAME} armor.chest with minecraft:elytra`)
  if (kit !== 'no_rockets') rcon(`give ${NAME} minecraft:firework_rocket 16`)
  if (kit === 'roof') rcon('fill -8 67 -8 145 67 8 minecraft:stone')
  await sleep(1500)
}
async function scenario(name, kit, request, target, expected, stopping = false) {
  await reset(kit)
  const started = Date.now(), logAt = report.log.length, before = { position: position(), rockets: rockets(), health: health(), inventory: inventory(), equipment: equipment() }
  owner.chat(`bot ${request}`)
  if (stopping) {
    await until(() => /\[flight\] \d+ (CLIMB|CRUISE)/.test(report.log.slice(logAt)), 40_000)
    await sleep(800); owner.chat('bot stop')
    await until(() => report.messages.some((m) => m.at >= started && /已提前落地/.test(m.text)), 80_000)
    await sleep(1500)
  } else await until(() => report.messages.some((m) => m.at >= started && /^(到了 |到 营地 了)/.test(m.text)), 120_000)
  const after = { position: position(), rockets: rockets(), health: health(), inventory: inventory(), equipment: equipment() }
  const flew = /\[flight\] \d+ TAKEOFF/.test(report.log.slice(logAt)), distance = Math.hypot(after.position.x - target.x, after.position.z - target.z)
  const ok = (stopping ? distance > 32 : distance <= 3) && flew === expected && after.health >= before.health &&
    (expected ? after.rockets < before.rockets : after.rockets === before.rockets) && (kit !== 'armor' || /minecraft:iron_chestplate/.test(after.equipment))
  report.results.push({ name, ok, request, target, before, after, flew, chat: report.messages.filter((m) => m.at >= started), log: report.log.slice(logAt) })
  console.log(JSON.stringify({ name, ok, flew, position: after.position, used: before.rockets - after.rockets }))
  if (!ok) throw new Error('交通场景验证不符：' + name)
}
const cases = {
  near: () => scenario('近路不飞', 'worn', '请去 20 64 0 等我', { x: 20, z: 0 }, false),
  far: () => scenario('远路自动飞行', 'worn', '请去 300 64 0 等我', { x: 300, z: 0 }, true),
  empty: () => scenario('空胸槽自动装备', 'inventory', '回营地等我', { x: 300.5, z: 0.5 }, true),
  supplies: () => scenario('缺烟花改步行', 'no_rockets', '请去 120 64 0 等我', { x: 120, z: 0 }, false),
  armor: () => scenario('普通胸甲保留步行', 'armor', '请去 120 64 0 等我', { x: 120, z: 0 }, false),
  roof: () => scenario('低屋顶选择步行', 'roof', '请去 120 64 0 等我', { x: 120, z: 0 }, false),
  walk: () => scenario('明确步行不飞', 'worn', '只步行去 120 64 0 等我', { x: 120, z: 0 }, false),
  stop: () => scenario('自动飞行中停止', 'worn', '请去 300 64 0 等我', { x: 300, z: 0 }, true, true),
}
async function run() {
  await start()
  for (const name of real ? ['empty'] : (selected.length ? selected : ['near', 'far', 'empty', 'supplies', 'armor', 'roof', 'walk', 'stop'])) {
    if (!cases[name]) throw new Error('未知测试场景')
    await cases[name]()
  }
  report.ok = true
}
run().catch((err) => { report.ok = false; report.error = err.message }).finally(async () => {
  owner?.quit(); child?.kill('SIGTERM'); await sleep(1200)
  if (child && child.exitCode === null) child.kill('SIGKILL')
  report.trace = trace; report.sandbox = sandbox
  const file = path.join(OUT, `live-auto-travel-${report.mode}-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ok: report.ok, error: report.error, passed: report.results.filter((r) => r.ok).length, evidence: file }))
  process.exitCode = report.ok ? 0 : 1
})
