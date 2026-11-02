// 隔离实验用：fake回放或real记录交通意图；绝不记录HTTP headers/密钥。
const fs = require('node:fs')
const original = globalThis.fetch
const API = 'https://api.deepseek.com/chat/completions'
globalThis.fetch = async (url, init) => {
  if (String(url) !== API) return original(url, init)
  const body = JSON.parse(init.body), last = JSON.parse(body.messages.at(-1).content)
  let output, response
  if (process.env.LAB_TRAVEL_AI_MODE === 'real') {
    response = await original(url, init)
    if (response.ok) {
      const data = await response.clone().json()
      output = JSON.parse(data.choices[0].message.content)
      if (!Array.isArray(output.actions) || output.actions.some((a) => !['goto', 'go', 'walk', 'come', 'stop'].includes(a?.cmd))) throw new Error('隔离交通测试拒绝执行模型生成的非交通动作')
    }
  } else {
    output = { reply: '我看看路线，去目的地。', actions: [], done: true }
    const message = last.message
    if (!message.startsWith('[系统]')) {
      const coordinates = message.match(/-?\d+(?:\.\d+)?/g)
      if (/营地/.test(message)) output.actions = [{ cmd: /只步行/.test(message) ? 'walk' : 'go', args: ['营地'] }]
      else if (/过来|来我/.test(message)) output.actions = [{ cmd: 'come', args: [] }]
      else if (coordinates?.length === 3) output.actions = [{ cmd: /只步行|别飞/.test(message) ? 'walk' : 'goto', args: coordinates }]
    }
    response = new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { total_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (process.env.LAB_TRAVEL_AI_TRACE) fs.appendFileSync(process.env.LAB_TRAVEL_AI_TRACE,
    JSON.stringify({ at: new Date().toISOString(), mode: process.env.LAB_TRAVEL_AI_MODE, message: last.message,
      state: last.state, model: body.model, output }) + '\n', { mode: 0o600 })
  return response
}
