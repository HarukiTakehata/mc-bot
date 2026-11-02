// 实验用：用 --require 预加载，替换 DeepSeek 请求。按玩家消息回放固定 JSON，验证"模型输出→校验→游戏执行"链路（不评价模型决策质量，也不用真实密钥）。
const SCRIPT = [
  [/砌堵墙 (\S+)/, (m) => ({ reply: '好，砌墙', actions: [{ cmd: 'build', args: ['wall', 'w=10', 'h=3', 'm=cobblestone', `at=${m[1]}`, 'f=north'] }], done: true })],
  [/钻石墙 (\S+)/, (m) => ({ reply: '用钻石块', actions: [{ cmd: 'build', args: ['wall', 'm=diamond_block', 'w=2', 'h=1', `at=${m[1]}`, 'f=north'] }], done: true })],
  [/搭灯 (\S+)/, (m) => ({ reply: '搭灯', actions: [{ cmd: 'circuit', args: ['lamp', `at=${m[1]}`, 'f=north'] }], done: true })],
  [/跳过去 (\S+) (\S+) (\S+)/, (m) => ({ reply: '跳', actions: [{ cmd: 'parkour', args: [m[1], m[2], m[3]] }], done: true })],
  [/冒险跳 (\S+) (\S+) (\S+)/, (m) => ({ reply: '跳', actions: [{ cmd: 'parkour', args: [m[1], m[2], m[3], 'risk'] }], done: true })],
  [/填大的/, () => ({ reply: '填', actions: [{ cmd: 'fill', args: ['0', '100', '0', '20', '100', '20', 'stone'] }], done: true })],
  [/炸掉/, () => ({ reply: '炸', actions: [{ cmd: 'fill', args: ['0', '100', '0', '0', '100', '0', 'tnt'] }], done: true })],
  [/挖掉高处 (\S+)/, (m) => ({ reply: '开挖', actions: [{ cmd: 'excavate', args: ['dirt', 'r=4', `above=${m[1]}`] }], done: true })],
  [/先拿木棍再拿木板/, () => ({ reply: '好', actions: [{ cmd: 'get', args: ['stick', '2'] }], done: false, plan: ['拿木棍', '拿木板'] })],
  [/没通过校验（reply 超过/, () => ({ reply: '改短了', actions: [{ cmd: 'chop', args: ['1'] }], done: true })],
  [/第一次写坏/, () => ({ reply: 'x'.repeat(300), actions: [], done: true })],
  [/闲聊/, () => ({ reply: '在呢', actions: [], done: true })],
]
const real = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('deepseek')) return real(url, init)
  const body = JSON.parse(init.body)
  const last = JSON.parse(body.messages.at(-1).content).message
  // 失败重新规划这类系统反馈：不再行动，结束本轮
  let out = { reply: '好的，这个做不了', actions: [], done: true }
  // 长指令续跑：第 2 轮做第二步，第 3 轮宣布完成
  if (/长期目标: 先拿木棍再拿木板/.test(last)) {
    const second = /第 2\//.test(last)
    out = second ? { reply: '拿木板', actions: [{ cmd: 'get', args: ['oak_planks', '2'] }], done: false, plan: ['✓拿木棍', '拿木板'] } : { reply: '都做完了', actions: [], done: true, check: { item: 'oak_planks', count: 2 } }
    const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { total_tokens: 0 } })
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const reply = (o) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }], usage: { total_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  // 清单账本：第一轮只做一项就谎报完成，程序应逼它做完第二项
  if (/^谎报完成/.test(last)) return reply({ reply: '都好了', actions: [{ cmd: 'get', args: ['stick', '2'] }], done: true, tasks: [{ id: 1, text: '拿木棍', status: 'done', verify: { item: 'stick', count: 2 } }, { id: 2, text: '拿木板', status: 'todo', verify: { item: 'oak_planks', count: 2 } }] })
  if (/长期目标: 谎报完成/.test(last)) return reply(/还没做完/.test(last) ? { reply: '补上', actions: [{ cmd: 'get', args: ['oak_planks', '2'] }], done: true, tasks: [{ id: 2, text: '拿木板', status: 'done' }] } : { reply: '好了', actions: [], done: true })
  // 验收：说挖完了其实没挖，程序应退回
  if (/^假装挖完 (\S+) (\S+)/.test(last)) { const [, y, x] = /假装挖完 (\S+) (\S+)/.exec(last); return reply({ reply: '挖完了', actions: [], done: true, tasks: [{ id: 1, text: '挖土', status: 'done', verify: { cleared: ['dirt'], r: 8, above: Number(y), center: [Number(x), 100, 0] } }] }) }
  if (/长期目标: 假装挖完/.test(last)) { const m = /假装挖完 (\S+)/.exec(last); return reply(/验收没过/.test(last) ? { reply: '这回真挖', actions: [{ cmd: 'excavate', args: ['dirt', 'r=8', `above=${m[1]}`] }], done: true, tasks: [{ id: 1, text: '挖土', status: 'done' }] } : { reply: '继续', actions: [], done: false }) }
  // 中途改要求
  if (/^做两件事/.test(last)) return reply({ reply: '开始', actions: [{ cmd: 'get', args: ['stick', '2'] }], done: false, tasks: [{ id: 1, text: '拿木棍', status: 'done' }, { id: 2, text: '等指示', status: 'todo' }] })
  if (/长期目标: 做两件事/.test(last)) return reply(/玩家新要求.*再拿木板/.test(last) ? { reply: '加上', actions: [{ cmd: 'get', args: ['oak_planks', '2'] }], done: true, tasks: [{ id: 2, text: '等指示', status: 'dropped' }, { text: '拿木板', status: 'done', verify: { item: 'oak_planks', count: 2 } }] } : { reply: '等你说', actions: [{ cmd: 'pickup', args: [] }], done: false })
  // 一轮输出坏掉不该毁掉长任务
  if (/^坏一轮/.test(last)) return reply({ reply: '开始', actions: [{ cmd: 'get', args: ['stick', '2'] }], done: false, tasks: [{ id: 1, text: '拿木棍', status: 'done' }, { id: 2, text: '拿木板', status: 'todo' }] })
  if (/长期目标: 坏一轮/.test(last)) { globalThis.__bad = (globalThis.__bad || 0) + 1; if (globalThis.__bad === 1) return new Response('{}', { status: 500 }); return reply({ reply: '拿木板', actions: [{ cmd: 'get', args: ['oak_planks', '2'] }], done: true, tasks: [{ id: 2, text: '拿木板', status: 'done' }] }) }
  // 记忆探针：把 state 里看到的记忆原样说出来
  if (/^记忆探针/.test(last)) { const st = JSON.parse(body.messages.at(-1).content).state; return reply({ reply: `经验${/过往经验: [^；]*探针任务/.test(st) ? '有' : '无'} 箱子${/箱子记忆: [^；]*iron_ingot/.test(st) ? '有' : '无'}`, actions: [], done: true }) }
  if (/^探针任务/.test(last)) return reply({ reply: '开始', actions: [{ cmd: 'get', args: ['stick', '2'] }], done: false, tasks: [{ id: 1, text: '拿木棍', status: 'doing', verify: { item: 'stick', count: 2 } }] })
  if (/长期目标: 探针任务/.test(last)) return reply({ reply: '好了', actions: [], done: true, tasks: [{ id: 1, text: '拿木棍', status: 'done' }] })
  // 空转：一直 find
  if (/^一直找/.test(last) || /长期目标: 一直找/.test(last)) return reply({ reply: '找', actions: [{ cmd: 'find', args: ['stone'] }], done: false, tasks: [{ id: 1, text: '找石头', status: 'doing' }] })
  for (const [re, fn] of SCRIPT) { const m = re.exec(last); if (m && (!last.startsWith('[系统]'))) { out = fn(m); break } }
  const text = JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { total_tokens: 0 } })
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })
}
