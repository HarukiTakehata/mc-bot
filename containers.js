'use strict'
// 箱子记忆（参考 AltoClef 的容器缓存）：记下开过的箱子里有什么。玩家随时可能动箱子，所以只是“上次看到”，拿东西时以当场为准。
const path = require('path')
const { readJSON, writeJSON } = require('./storage')

const FILE = path.join(__dirname, 'data', 'containers.json')
const MAX_CONTAINERS = 40
const MAX_TYPES = 16
const MAX_BYTES = 30_000
const keyOf = (dim, p) => `${dim}|${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const isName = (n) => typeof n === 'string' && n.length <= 64 && /^[a-z0-9_:./-]+$/.test(n)

function cleanEntry(e) {
  if (!e || typeof e !== 'object' || ![e.x, e.y, e.z].every(Number.isFinite) || typeof e.dim !== 'string' || e.dim.length > 100 || !e.items || typeof e.items !== 'object' || Array.isArray(e.items)) return null
  const items = Object.fromEntries(Object.entries(e.items).filter(([n, c]) => isName(n) && Number.isSafeInteger(c) && c > 0).slice(0, MAX_TYPES))
  return { x: e.x, y: e.y, z: e.z, dim: e.dim, items, at: Number.isFinite(e.at) ? e.at : 0 }
}
const distance = (e, from) => Math.hypot(e.x - from.x, e.y - from.y, e.z - from.z)

function createContainers({ file = FILE, now = Date.now } = {}) {
  const saved = readJSON(file, {})
  const map = new Map()
  for (const raw of Array.isArray(saved?.containers) ? saved.containers : []) {
    const e = cleanEntry(raw)
    if (e) map.set(keyOf(e.dim, e), e)
  }
  function persist() {
    const list = () => JSON.stringify({ containers: [...map.values()] }, null, 2)
    while (map.size > 1 && (map.size > MAX_CONTAINERS || Buffer.byteLength(list()) > MAX_BYTES)) {
      const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)[0][0]
      map.delete(oldest)
    }
    try { writeJSON(file, { containers: [...map.values()] }) } catch (err) { console.log('[containers] 保存失败', err.message) }
  }
  return {
    // double：大箱子从哪一半打开都是同一份东西，相邻半边的旧记录要去掉，否则数量算两遍
    update(pos, dim, stacks, { double = false } = {}) {
      const counts = {}
      for (const s of stacks) if (isName(s?.name) && Number.isSafeInteger(s.count) && s.count > 0) counts[s.name] = (counts[s.name] || 0) + s.count
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, MAX_TYPES)
      const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
      if (double) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) map.delete(keyOf(dim, { x: p.x + dx, y: p.y, z: p.z + dz }))
      map.set(keyOf(dim, p), { ...p, dim, items: Object.fromEntries(top), at: now() })
      persist()
    },
    drop(pos, dim) { if (map.delete(keyOf(dim, pos))) persist() },
    // 存着这个物品的箱子，近的在前
    find(name, dim, from) {
      return [...map.values()].filter((e) => e.dim === dim && e.items[name] > 0)
        .sort((a, b) => distance(a, from) - distance(b, from)).map((e) => ({ x: e.x, y: e.y, z: e.z, count: e.items[name], at: e.at }))
    },
    // 给 AI 的摘要：提到的物品排前面，其余按数量
    describe(dim, from, text = '', limit = 12) {
      const totals = new Map()
      for (const e of [...map.values()].filter((c) => c.dim === dim).sort((a, b) => distance(a, from) - distance(b, from))) {
        for (const [name, count] of Object.entries(e.items)) {
          const t = totals.get(name)
          if (t) t.count += count
          else totals.set(name, { name, count, at: `${e.x},${e.y},${e.z}` })
        }
      }
      const wanted = String(text).toLowerCase()
      return [...totals.values()].sort((a, b) => Number(wanted.includes(b.name)) - Number(wanted.includes(a.name)) || b.count - a.count)
        .slice(0, limit).map((t) => `${t.name}x${t.count}(最近 ${t.at})`).join(' ')
    },
    size: () => map.size,
    clear() { map.clear(); persist() },
  }
}

module.exports = { createContainers }
