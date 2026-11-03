// 自定义工作流：在 workflows/ 里放 .json，把一串指令编排成一件事，可以手动跑（bot run <id>）、让 AI 调用、或者按条件自动触发。
//
// {
//   "id": "wood", "name": "补木头", "description": "背包木头不够 16 就去砍",
//   "ai": true,                       // 允许 AI 用 run 调用（只能包含 AI 也能下的指令）
//   "trigger": { "on": "idle", "cooldown": 600 },   // manual（默认）/spawn/night/day/playerJoined/idle/interval（配 every 秒）
//   "onFail": "stop",                 // 一步失败：stop 停（默认）/ continue 接着做
//   "steps": [
//     { "if": { "has": "oak_log", "lt": 16 }, "do": "chop", "args": ["16"] },
//     { "do": "craft", "args": ["chest", "1"] },
//     { "say": "箱子做好了" },
//     { "wait": 5 },
//     { "repeat": 3, "steps": [ { "do": "fish", "args": ["1"] } ] },
//     { "ask": "把箱子放在我旁边" }      // 交给 AI（要配置了 AI）
//   ]
// }
//
// 边界：每一步指令都过和玩家指令同一套 normalizeAction 校验；不能调用 run/goal/auto（不嵌套、不套娃）；
// 展开后最多 200 步、wait 最多 600 秒、整个工作流最多 maxMinutes（默认 30，最多 240）分钟；bot stop 随时停；
// 自动触发只在完全空闲时、过了冷却才跑，全局可用 MC_WORKFLOWS_AUTO=off 关掉。
const fs = require('node:fs')
const path = require('node:path')
const { normalizeAction, AI_ACTIONS } = require('./security')

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const TRIGGERS = new Set(['manual', 'spawn', 'night', 'day', 'playerJoined', 'idle', 'interval'])
const FORBIDDEN = new Set(['run', 'goal', 'auto', 'replan', 'workflows'])
const FIELDS = new Set(['id', 'name', 'description', 'ai', 'trigger', 'onFail', 'steps', 'maxMinutes', '$comment'])
const LIMITS = { files: 64, fileBytes: 64 * 1024, steps: 200, depth: 3, wait: 600, repeat: 16, text: 300 }
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u

function text(v, max, field) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || CONTROL.test(v) || v !== v.toWellFormed()) throw new Error(`${field} 必须是 1 到 ${max} 字的单行文本`)
  return v.trim()
}

function condition(c, where) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: if 必须是对象`)
  const keys = Object.keys(c)
  if (Object.hasOwn(c, 'has')) {
    if (!keys.every((k) => ['has', 'lt', 'gte'].includes(k)) || (c.lt === undefined) === (c.gte === undefined)) throw new Error(`${where}: has 条件写成 { "has": 物品, "lt": 数量 } 或 { "has": 物品, "gte": 数量 }`)
    const n = c.lt ?? c.gte
    if (!Number.isSafeInteger(n) || n < 0 || n > 4096) throw new Error(`${where}: 数量必须是 0 到 4096`)
    const item = normalizeAction('find', [String(c.has)]).args[0]
    return c.lt !== undefined ? { has: item, lt: n } : { has: item, gte: n }
  }
  if (keys.length === 1 && Object.hasOwn(c, 'time')) {
    if (!['day', 'night'].includes(c.time)) throw new Error(`${where}: time 只能是 day/night`)
    return { time: c.time }
  }
  for (const k of ['healthBelow', 'foodBelow']) {
    if (keys.length === 1 && Object.hasOwn(c, k)) {
      if (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 20) throw new Error(`${where}: ${k} 必须是 1 到 20`)
      return { [k]: c[k] }
    }
  }
  throw new Error(`${where}: 不认识的条件（支持 has+lt/gte、time、healthBelow、foodBelow）`)
}

// 规整步骤；ai 为 true 时只许 AI 能用的指令
function steps(list, { ai, depth = 1, counter, extensionCommands }, where = 'steps') {
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.steps) throw new Error(`${where} 必须是 1 到 ${LIMITS.steps} 项的数组`)
  if (depth > LIMITS.depth) throw new Error(`${where}: repeat 最多嵌套 ${LIMITS.depth - 1} 层`)
  return list.map((raw, i) => {
    const at = `${where}[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} 必须是对象`)
    const kinds = ['do', 'say', 'wait', 'repeat', 'ask'].filter((k) => Object.hasOwn(raw, k))
    if (kinds.length !== 1) throw new Error(`${at} 必须且只能有 do/say/wait/repeat/ask 之一`)
    const allowed = { do: ['do', 'args', 'if'], say: ['say', 'if'], wait: ['wait', 'if'], repeat: ['repeat', 'steps', 'if'], ask: ['ask', 'if'] }[kinds[0]]
    for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new Error(`${at} 多了字段 ${k}`)
    const step = raw.if === undefined ? {} : { if: condition(raw.if, at) }
    if (kinds[0] === 'do') {
      const cmd = String(raw.do).toLowerCase()
      if (FORBIDDEN.has(cmd)) throw new Error(`${at}: 工作流里不能用 ${cmd}`)
      const args = raw.args === undefined ? [] : raw.args
      if (extensionCommands?.has(cmd)) {
        if (ai) throw new Error(`${at}: AI 可调用的工作流不能用扩展指令 ${cmd}`)
        if (!Array.isArray(args) || args.length > 8 || args.some((a) => typeof a !== 'string' || !a || a.length > 64)) throw new Error(`${at}: 扩展指令参数不合法`)
        Object.assign(step, { do: cmd, args: [...args], extension: true })
      } else {
        let checked
        try { checked = normalizeAction(cmd, args, { ai }) } catch (err) { throw new Error(`${at}: ${err.message}`) }
        Object.assign(step, { do: checked.cmd, args: checked.args })
      }
      counter.n++
    } else if (kinds[0] === 'say') { step.say = text(raw.say, LIMITS.text, `${at}.say`); counter.n++ }
    else if (kinds[0] === 'ask') {
      // AI 调用的工作流里不能再问 AI：AI 正在等这个工作流的结果，会互相等死
      if (ai) throw new Error(`${at}: ai 工作流里不能用 ask`)
      step.ask = text(raw.ask, LIMITS.text, `${at}.ask`); counter.n++
    }
    else if (kinds[0] === 'wait') {
      if (!Number.isFinite(raw.wait) || raw.wait <= 0 || raw.wait > LIMITS.wait) throw new Error(`${at}: wait 必须是 0 到 ${LIMITS.wait} 秒`)
      step.wait = raw.wait; counter.n++
    } else {
      if (!Number.isInteger(raw.repeat) || raw.repeat < 1 || raw.repeat > LIMITS.repeat) throw new Error(`${at}: repeat 必须是 1 到 ${LIMITS.repeat}`)
      const before = counter.n
      step.repeat = raw.repeat
      step.steps = steps(raw.steps, { ai, depth: depth + 1, counter, extensionCommands }, `${at}.steps`)
      counter.n = before + (counter.n - before) * raw.repeat
    }
    if (counter.n > LIMITS.steps) throw new Error(`展开后超过 ${LIMITS.steps} 步`)
    return step
  })
}

function validate(raw, { extensionCommands } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作流必须是对象')
  for (const k of Object.keys(raw)) if (!FIELDS.has(k)) throw new Error(`不认识的字段 ${k}`)
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) throw new Error('id 只能用小写字母、数字、_ 和 -，最长 48')
  const ai = raw.ai === true
  if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new Error('ai 必须是 true/false')
  const trigger = { on: 'manual', cooldown: 300 }
  if (raw.trigger !== undefined) {
    const t = raw.trigger
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('trigger 必须是对象')
    for (const k of Object.keys(t)) if (!['on', 'every', 'cooldown'].includes(k)) throw new Error(`trigger 多了字段 ${k}`)
    if (!TRIGGERS.has(t.on)) throw new Error(`trigger.on 只能是 ${[...TRIGGERS].join('/')}`)
    trigger.on = t.on
    if (t.on === 'interval') {
      if (!Number.isInteger(t.every) || t.every < 60 || t.every > 86_400) throw new Error('interval 的 every 必须是 60 到 86400 秒')
      trigger.every = t.every
    } else if (t.every !== undefined) throw new Error('只有 interval 能写 every')
    if (t.cooldown !== undefined) {
      if (!Number.isInteger(t.cooldown) || t.cooldown < 30 || t.cooldown > 86_400) throw new Error('cooldown 必须是 30 到 86400 秒')
      trigger.cooldown = t.cooldown
    }
  }
  if (raw.onFail !== undefined && !['stop', 'continue'].includes(raw.onFail)) throw new Error('onFail 只能是 stop/continue')
  const maxMinutes = raw.maxMinutes ?? 30
  if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) throw new Error('maxMinutes 必须是 1 到 240')
  const counter = { n: 0 }
  return {
    id: raw.id,
    name: raw.name === undefined ? raw.id : text(raw.name, 48, 'name'),
    description: raw.description === undefined ? '' : text(raw.description, 160, 'description'),
    ai, trigger, onFail: raw.onFail || 'stop', maxMinutes,
    steps: steps(raw.steps, { ai, counter, extensionCommands }),
    size: counter.n,
  }
}

function loadWorkflows(dir, { log = console.log, extensionCommands } = {}) {
  const out = new Map()
  let names
  try { names = fs.readdirSync(dir) } catch (err) { if (err.code !== 'ENOENT') log(`[workflow] 读不了 ${dir}: ${err.message}`); return out }
  for (const name of names.filter((n) => /^[a-z0-9][a-z0-9_-]*\.json$/.test(n)).sort().slice(0, LIMITS.files)) {
    const file = path.join(dir, name)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile()) throw new Error('不是普通文件（不支持符号链接）')
      if (stat.size > LIMITS.fileBytes) throw new Error('文件超过 64KB')
      const wf = validate(JSON.parse(fs.readFileSync(file, 'utf8')), { extensionCommands })
      if (out.has(wf.id)) throw new Error(`id ${wf.id} 重复`)
      out.set(wf.id, wf)
    } catch (err) { log(`[workflow] 跳过 ${name}: ${err.message}`) }
  }
  return out
}

// 执行器。deps 由 bot.js 提供：
//   exec(cmd, args, { extension }) → Promise<{ ok, stopped?, error?, said? }>
//   ask(text) → Promise<{ ok }>；say(text)；sleep(ms)（可被 stop 打断）；inventoryCount(item)；isNight()；health()；food()
//   isCancelled() → 被 bot stop 了
function createRunner(deps) {
  const check = (c) => {
    if (!c) return true
    if (c.has) { const n = deps.inventoryCount(c.has); return c.lt !== undefined ? n < c.lt : n >= c.gte }
    if (c.time) return (c.time === 'night') === deps.isNight()
    if (c.healthBelow) return deps.health() < c.healthBelow
    if (c.foodBelow) return deps.food() < c.foodBelow
    return true
  }
  async function runSteps(list, ctx) {
    for (const step of list) {
      if (deps.isCancelled() || Date.now() > ctx.deadline) return { ok: false, stopped: deps.isCancelled(), error: deps.isCancelled() ? '被停下' : '超过时限' }
      if (!check(step.if)) continue
      ctx.done++
      let result = { ok: true }
      if (step.do) result = await deps.exec(step.do, step.args, { extension: !!step.extension })
      else if (step.say) deps.say(step.say)
      else if (step.ask) result = await deps.ask(step.ask)
      else if (step.wait) await deps.sleep(step.wait * 1000)
      else if (step.repeat) {
        for (let i = 0; i < step.repeat; i++) {
          result = await runSteps(step.steps, ctx)
          if (!result.ok) break
        }
      }
      if (result?.stopped || deps.isCancelled()) return { ok: false, stopped: true, error: '被停下' }
      if (result && result.ok === false) {
        ctx.failures.push(`${step.do || (step.ask ? 'ask' : step.repeat ? 'repeat' : '?')}${result.error ? `: ${String(result.error).slice(0, 80)}` : ''}`)
        if (ctx.onFail === 'stop') return { ok: false, error: ctx.failures.at(-1) }
      }
    }
    return { ok: !ctx.failures.length }
  }
  return async function run(wf) {
    const ctx = { done: 0, failures: [], onFail: wf.onFail, deadline: Date.now() + wf.maxMinutes * 60_000 }
    const result = await runSteps(wf.steps, ctx)
    return { ...result, steps: ctx.done, failures: ctx.failures }
  }
}

module.exports = { loadWorkflows, validate, createRunner, LIMITS, AI_ACTIONS }
