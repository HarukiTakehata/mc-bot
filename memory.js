// 持久笔记：AI 用 note 指令记下的事（基地在哪、谁要什么），重启后还在，会放进 AI 的提示词。
const path = require('path')
const { readJSON, writeJSON } = require('./storage')

const FILE = path.join(__dirname, 'data', 'memory.json')
const MAX_NOTES = 20

const loaded = readJSON(FILE, {})
let notes = Array.isArray(loaded?.notes)
  ? loaded.notes.filter((n) => typeof n === 'string' && n.length <= 100).slice(-MAX_NOTES) : []

module.exports = {
  add(text) {
    const note = String(text).trim().slice(0, 100)
    if (!note || notes.includes(note)) return
    const next = [...notes, note].slice(-MAX_NOTES)
    writeJSON(FILE, { notes: next })
    notes = next
  },
  list: () => [...notes],
}
