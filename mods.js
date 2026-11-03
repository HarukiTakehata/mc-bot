// 模组扩展：内置的在 mods/，自己加的放 extensions/（同 id 覆盖内置）。
//
// .json：只有数据（组件编码、知识、AI 提示、服务器规则），不执行任何代码，别人发来的也能放心装。
// .js：在数据之外还能写 setup(api) 注册指令、监听事件。它和机器人本身一样有本机全部权限，只装自己看过、信得过的。
//
// 什么时候生效（activate）：
//   auto   默认。服务器同步来的注册表里出现了 namespaces 里的命名空间才启用（只有 Fabric 服会同步注册表）
//   always 总是启用（适合不挑服务器的通用扩展）
//   manual 只有 MC_MODS 里点名才启用（纯服务端模组不进注册表，比如共享背包，只能手动开）
// MC_MODS=a,b 强制启用；MC_MODS_DISABLE=a,b 强制停用（优先于一切）。
const fs = require('node:fs')
const path = require('node:path')

const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const NAMESPACE = /^[a-z0-9_.-]{1,64}$/
const RESOURCE = /^([a-z0-9_.-]{1,64}):[a-z0-9_./-]{1,128}$/
const COMMAND = /^[a-z]{2,20}$/
// 组件编码只许用自带长度或定长的基础类型：写错了顶多这个物品解析失败，不会让后面整包读歪
const CODECS = new Set(['bool', 'u8', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64', 'varint', 'varlong', 'string', 'UUID', 'anonymousNbt', 'GlobalPos', 'position', 'vec3f'])
const FEATURES = { sharedInventory: '共享背包', sharedHealth: '共享血量' }
const ACTIVATE = new Set(['auto', 'always', 'manual'])
const FIELDS = new Set(['id', 'name', 'summary', 'namespaces', 'activate', 'features', 'components', 'tips', 'prompt', 'setup'])
const LIMITS = { files: 64, fileBytes: 256 * 1024, namespaces: 16, components: 256, tips: 32, keys: 16, key: 40, tip: 160, summary: 160, prompt: 300, promptTotal: 1200, errors: 10 }
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u

function text(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value) || value !== value.toWellFormed()) throw new Error(`${field} 必须是 1 到 ${max} 个字符的单行文本`)
  return value.trim()
}
const list = (value, max, field) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} 必须是最多 ${max} 项的数组`)
  return value
}

// 校验并规整一份扩展定义；任何不认识或越界的字段都直接拒绝，不猜
function validate(raw, { code = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('扩展必须导出一个对象')
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) throw new Error(`不认识的字段 ${key}`)
  const id = raw.id
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('id 只能用小写字母、数字和 _.-，最长 64')
  const def = {
    id,
    name: raw.name === undefined ? id : text(raw.name, 64, 'name'),
    summary: raw.summary === undefined ? null : text(raw.summary, LIMITS.summary, 'summary'),
    activate: raw.activate ?? 'auto',
    namespaces: list(raw.namespaces ?? [], LIMITS.namespaces, 'namespaces'),
    features: Object.create(null),
    components: new Map(),
    tips: [],
    prompt: raw.prompt === undefined ? null : text(raw.prompt, LIMITS.prompt, 'prompt'),
    setup: null,
  }
  if (!ACTIVATE.has(def.activate)) throw new Error('activate 只能是 auto/always/manual')
  for (const ns of def.namespaces) if (typeof ns !== 'string' || !NAMESPACE.test(ns) || ns === 'minecraft') throw new Error(`命名空间 ${String(ns).slice(0, 64)} 不合法（也不能是 minecraft）`)
  if (def.activate === 'auto' && !def.namespaces.length) throw new Error('auto 扩展必须写 namespaces，不然永远不会启用')
  if (raw.features !== undefined) {
    if (!raw.features || typeof raw.features !== 'object' || Array.isArray(raw.features)) throw new Error('features 必须是对象')
    for (const [key, on] of Object.entries(raw.features)) {
      if (!Object.hasOwn(FEATURES, key) || typeof on !== 'boolean') throw new Error(`features 只支持 ${Object.keys(FEATURES).join('/')}，值为 true/false`)
      def.features[key] = on
    }
  }
  if (raw.components !== undefined) {
    if (!raw.components || typeof raw.components !== 'object' || Array.isArray(raw.components)) throw new Error('components 必须是对象')
    const entries = Object.entries(raw.components)
    if (entries.length > LIMITS.components) throw new Error(`components 最多 ${LIMITS.components} 项`)
    for (const [full, codec] of entries) {
      const m = RESOURCE.exec(full)
      // 只能声明自己命名空间下的组件：不许改原版组件，也不许替别的模组改
      if (!m || !def.namespaces.includes(m[1])) throw new Error(`组件 ${full.slice(0, 80)} 必须属于本扩展的 namespaces`)
      if (!CODECS.has(codec)) throw new Error(`组件 ${full} 的编码 ${String(codec).slice(0, 32)} 不在允许列表（${[...CODECS].join(' ')}）`)
      def.components.set(full, codec)
    }
  }
  for (const tip of list(raw.tips ?? [], LIMITS.tips, 'tips')) {
    if (!tip || typeof tip !== 'object' || Array.isArray(tip)) throw new Error('tips 每项必须是 { keys, text }')
    const keys = list(tip.keys, LIMITS.keys, 'tips.keys').map((k) => text(k, LIMITS.key, 'tips.keys').toLowerCase())
    if (!keys.length) throw new Error('tips.keys 不能为空')
    def.tips.push({ keys, text: text(tip.text, LIMITS.tip, 'tips.text') })
  }
  if (raw.setup !== undefined) {
    if (!code) throw new Error('只有 .js 扩展能写 setup')
    if (typeof raw.setup !== 'function') throw new Error('setup 必须是函数')
    def.setup = raw.setup
  }
  return def
}

// 读一个目录里的扩展文件。坏文件只跳过它自己，并说清楚原因
function readDir(dir, log) {
  let names
  try { names = fs.readdirSync(dir) } catch (err) { if (err.code !== 'ENOENT') log(`[mods] 读不了 ${dir}: ${err.message}`); return [] }
  names = names.filter((n) => /^[a-z0-9][a-z0-9_.-]*\.(json|js)$/.test(n)).sort()
  if (names.length > LIMITS.files) { log(`[mods] ${dir} 里扩展超过 ${LIMITS.files} 个，只读前 ${LIMITS.files} 个`); names = names.slice(0, LIMITS.files) }
  const root = fs.realpathSync(dir)
  const defs = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = fs.lstatSync(file)
      // 不跟符号链接、不读目录外的文件：放进来的是什么就只读什么
      if (!stat.isFile()) throw new Error('不是普通文件（不支持符号链接）')
      if (path.dirname(fs.realpathSync(file)) !== root) throw new Error('文件不在扩展目录里')
      if (stat.size > LIMITS.fileBytes) throw new Error(`文件超过 ${LIMITS.fileBytes / 1024}KB`)
      const code = name.endsWith('.js')
      const raw = code ? require(file) : JSON.parse(fs.readFileSync(file, 'utf8'))
      defs.push({ ...validate(raw, { code }), file })
    } catch (err) {
      log(`[mods] 跳过 ${name}: ${err.message}`)
    }
  }
  return defs
}

function splitList(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean))
}

function createMods({ builtinDir = path.join(__dirname, 'mods'), userDir = path.join(__dirname, 'extensions'), defs, enable = '', disable = '', log = console.log } = {}) {
  const byId = new Map()
  if (defs) for (const d of defs) byId.set(d.id, d)
  else {
    for (const d of readDir(builtinDir, log)) byId.set(d.id, { ...d, builtin: true })
    for (const d of readDir(userDir, log)) {
      if (byId.get(d.id)?.builtin) log(`[mods] ${path.basename(d.file)} 覆盖内置扩展 ${d.id}`)
      else if (byId.has(d.id)) { log(`[mods] 跳过 ${path.basename(d.file)}: id ${d.id} 重复`); continue }
      byId.set(d.id, d)
    }
  }
  const enabled = splitList(enable)
  const disabled = splitList(disable)
  for (const id of [...enabled, ...disabled]) if (!byId.has(id)) log(`[mods] MC_MODS/MC_MODS_DISABLE 里的 ${id.slice(0, 64)} 没有对应扩展`)

  let active = null
  let codecs = new Map()
  // namespaces：服务器注册表里出现过的命名空间；null 表示服务器没同步注册表（原版/Paper/Spigot）
  function activate(namespaces = null) {
    if (active) return active
    const seen = namespaces ? new Set(namespaces) : new Set()
    active = [...byId.values()].filter((d) => {
      if (disabled.has(d.id)) return false
      if (enabled.has(d.id) || d.activate === 'always') return true
      return d.activate === 'auto' && d.namespaces.some((ns) => seen.has(ns))
    })
    // 两个扩展给同一个组件写了不同编码：都不用，宁可这个组件解析失败也不按错的编码读
    const owners = new Map()
    for (const d of active) for (const [full, codec] of d.components) {
      const prev = owners.get(full)
      if (prev && prev.codec !== codec) { prev.conflict = true; log(`[mods] 组件 ${full} 在 ${prev.id} 和 ${d.id} 里编码不同，两个都不用`) }
      else if (!prev) owners.set(full, { id: d.id, codec })
    }
    codecs = new Map([...owners].filter(([, o]) => !o.conflict).map(([full, o]) => [full, o.codec]))
    if (active.length) log(`[mods] 启用 ${active.map((d) => d.id).join(', ')}`)
    return active
  }
  const current = () => active || []
  const features = () => {
    const out = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, false]))
    for (const d of current()) for (const [k, on] of Object.entries(d.features)) if (on) out[k] = true
    return out
  }
  const tips = () => current().flatMap((d) => d.tips)
  // 模组物品 → 它所属扩展的一句话说明
  function summaryFor(fullName) {
    const ns = String(fullName).split(':')[0]
    const d = current().find((x) => x.namespaces.includes(ns))
    return d ? (d.summary || d.tips[0]?.text || null) : null
  }
  // 给 AI 系统提示追加的服务器规则和模组说明（来自本机文件，算可信；仍限总长）
  function promptNotes() {
    const f = features()
    const rules = Object.entries(FEATURES).filter(([k]) => f[k]).map(([, label]) => label)
    const lines = [rules.length && `本服规则：${rules.join('、')}（一人拿走/受伤全队受影响，用稀有物品、冒险前先问一句）`, ...current().map((d) => d.prompt)].filter(Boolean)
    let out = ''
    for (const line of lines) { if (out.length + line.length + 1 > LIMITS.promptTotal) break; out += (out ? '\n' : '') + line }
    return out
  }

  // 只给 .js 扩展：注册指令、监听事件。出错只记日志，反复出错就停掉这个扩展的监听
  function setupAll({ bot, registerCommand, ctx }) {
    for (const d of current()) {
      if (!d.setup) continue
      let errors = 0
      const listeners = []
      const fault = (where, err) => {
        log(`[mods:${d.id}] ${where} 出错: ${err?.message || err}`)
        if (++errors === LIMITS.errors) {
          for (const [event, fn] of listeners.splice(0)) bot.removeListener(event, fn)
          log(`[mods:${d.id}] 连续出错 ${LIMITS.errors} 次，已停用它的事件监听`)
        }
      }
      const api = {
        id: d.id,
        bot,
        log: (...args) => log(`[mods:${d.id}]`, ...args),
        say: ctx.say,
        sleep: ctx.sleepMs,
        features: features(),
        on(event, fn) {
          if (typeof event !== 'string' || typeof fn !== 'function') throw new TypeError('api.on(事件名, 函数)')
          if (errors >= LIMITS.errors) return
          const wrapped = (...args) => { try { const r = fn(...args); if (r?.catch) r.catch((err) => fault(event, err)) } catch (err) { fault(event, err) } }
          listeners.push([event, wrapped])
          bot.on(event, wrapped)
        },
        command(name, spec) {
          if (typeof name !== 'string' || !COMMAND.test(name)) throw new Error(`指令名 ${String(name).slice(0, 32)} 只能是 2 到 20 个小写字母`)
          if (!spec || typeof spec.run !== 'function') throw new Error('api.command(名字, { run(user, args), help, read })')
          const help = spec.help === undefined ? '' : text(spec.help, 120, 'help')
          registerCommand(name, { id: d.id, help, read: spec.read === true, run: spec.run })
        },
      }
      try {
        const r = d.setup(api)
        if (r?.catch) r.catch((err) => fault('setup', err))
      } catch (err) { fault('setup', err) }
    }
  }

  return { activate, active: current, features, tips, summaryFor, promptNotes, componentCodecs: () => new Map(codecs), setupAll, all: () => [...byId.values()] }
}

module.exports = { createMods, validate, CODECS, FEATURES, LIMITS }
