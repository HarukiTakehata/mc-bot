'use strict'
// 长任务的任务清单：程序记账，模型只能更新状态。模型漏写的任务不会消失，说完成也要过验收。

const MAX_TASKS = 16
const STATUS = new Set(['todo', 'doing', 'done', 'failed', 'dropped'])
const STATUS_TEXT = { todo: '待做', doing: '进行中', done: '完成', failed: '失败', dropped: '取消' }
const clean = (t, max) => String(t).replace(/[\p{Cc}\p{Cf}]/gu, '').toWellFormed().trim().slice(0, max)
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const coords = (v) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Math.floor) : undefined)
const blockName = (v) => (typeof v === 'string' && /^[a-z0-9_:]{1,64}$/.test(v.replace(/^minecraft:/, '')) ? v.replace(/^minecraft:/, '') : undefined)

// 验收条件来自模型，只接受固定形状；不合格就当没写，不作废整轮
function parseVerify(v) {
  if (!isRecord(v)) return undefined
  const num = (x, lo, hi, dflt) => (Number.isFinite(Number(x)) && x !== null ? Math.min(hi, Math.max(lo, Math.floor(Number(x)))) : dflt)
  if (typeof v.item === 'string') {
    const item = blockName(v.item), count = num(v.count, 1, 4096, 1)
    return item ? { item, count } : undefined
  }
  if (v.near !== undefined) {
    const near = coords(v.near)
    return near ? { near, r: num(v.r, 1, 64, 4) } : undefined
  }
  if (v.placed !== undefined) {
    const at = coords(v.at), placed = blockName(v.placed)
    return at && placed ? { placed, at } : undefined
  }
  if (v.cleared !== undefined) {
    const blocks = (Array.isArray(v.cleared) ? v.cleared : [v.cleared]).map(blockName).filter(Boolean).slice(0, 6)
    if (!blocks.length) return undefined
    const out = { cleared: blocks, r: num(v.r, 1, 32, 16), left: num(v.left, 0, 512, 0) }
    if (coords(v.center)) out.center = coords(v.center)
    if (Number.isFinite(v.above)) out.above = Math.floor(v.above)
    if (Number.isFinite(v.below)) out.below = Math.floor(v.below)
    return out
  }
  return undefined
}

function parseTasks(tasks) {
  if (!Array.isArray(tasks)) return undefined
  const out = []
  for (const t of tasks.slice(0, MAX_TASKS)) {
    if (!isRecord(t) || typeof t.text !== 'string' || !clean(t.text, 60)) continue
    const task = { text: clean(t.text, 60), status: STATUS.has(t.status) ? t.status : 'todo' }
    if (Number.isSafeInteger(t.id) && t.id > 0) task.id = t.id
    const verify = parseVerify(t.verify)
    if (verify) task.verify = verify
    if (typeof t.why === 'string' && clean(t.why, 60)) task.why = clean(t.why, 60)
    out.push(task)
  }
  return out.length ? out : undefined
}

// 模型没提到的旧任务保留：这正是“长指令漏做后半截”的来源
function mergeTasks(ledger, incoming) {
  const out = ledger.map((t) => ({ ...t }))
  let next = out.reduce((n, t) => Math.max(n, t.id), 0) + 1
  for (const t of incoming || []) {
    const hit = (t.id && out.find((o) => o.id === t.id)) || out.find((o) => o.text === t.text)
    if (hit) {
      hit.status = t.status
      if (t.verify) hit.verify = t.verify
      if (t.why) hit.why = t.why
    } else if (out.length < MAX_TASKS) {
      const { id: _ignored, ...rest } = t
      out.push({ ...rest, id: next++ })
    }
  }
  return out
}

// 旧式 plan 字符串（✓ 前缀表示完成）：只用来展示，不拦收工
function tasksFromPlan(plan) {
  return plan.map((p, i) => ({ id: i + 1, text: clean(String(p).replace(/^✓\s*/, ''), 60), status: /^✓/.test(p) ? 'done' : 'todo', soft: true }))
}

const pending = (ledger) => ledger.filter((t) => !t.soft && (t.status === 'todo' || t.status === 'doing'))
const describeTasks = (ledger) => ledger.map((t) => `#${t.id}[${STATUS_TEXT[t.status]}]${t.text}${t.why ? `（${t.why}）` : ''}`).join(' ')
function summarize(ledger) {
  const done = ledger.filter((t) => t.status === 'done').length
  const failed = ledger.filter((t) => t.status === 'failed').map((t) => t.text)
  const open = pending(ledger).map((t) => t.text)
  return [`完成 ${done}/${ledger.length}`, failed.length && `失败: ${failed.join('、')}`, open.length && `没做: ${open.join('、')}`].filter(Boolean).join('；').slice(0, 200)
}
function restoreTasks(saved) {
  if (!Array.isArray(saved)) return []
  const parsed = parseTasks(saved) || []
  return parsed.map((t, i) => ({ ...t, id: t.id || i + 1 }))
}

// 同样的动作没带来任何变化：find 反复“找到”但世界没变就是这种（实测日志：找grass_block 连续三轮）
function stallTracker() {
  let last = null
  let count = 0
  return (labels, changed) => {
    const key = labels.join('|')
    count = key && key === last && !changed ? count + 1 : 0
    last = key
    return count
  }
}

const CANCEL = /^(算了|取消|别做了|别干了|不用了|不做了|停下|停一下|先停|停)[!！。.~～ ]*$/
const STATUS_QUESTION = /(在|你)(干嘛|干啥|做什么|干什么|忙什么|忙啥)|做到哪|到哪了|进度|还要多久|卡住了吗|做完了吗/

module.exports = { parseVerify, parseTasks, mergeTasks, tasksFromPlan, pending, describeTasks, summarize, restoreTasks, stallTracker, CANCEL, STATUS_QUESTION }
