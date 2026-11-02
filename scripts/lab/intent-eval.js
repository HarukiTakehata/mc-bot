// 真实模型的理解力评测：不进游戏，把真实玩家说过的话和场景喂给模型，只检查它选的动作和清单。
// 用法：DEEPSEEK_API_KEY=... node scripts/lab/intent-eval.js [--model=x] [--off]（--off 关思考，用来对比）
const { createAI } = require('../../ai')
const STATE = '位置 100 70 200；血量 20/20 饱食 20/20；白天；说话的玩家 luomo 在 110 70 205，正看着 oak_log@112,72,205；附近方块: oak_logx12, dirt多；记住的地点: 家(0,64,0)；背包: iron_pickaxex1, cobblestonex32'
const cmds = (r) => r.actions.map((a) => a.cmd)
const CASES = [
  ['条件挖掘', '把附近高于76格的土和草方块全部挖掉', '', (r) => cmds(r).includes('excavate') && !cmds(r).includes('find')],
  ['承接上文', '挖掉所有符合条件的方块', '把附近高于76格的土和草方块全部挖掉', (r) => cmds(r).includes('excavate') && r.actions.some((a) => a.args.some((x) => /above=76/.test(x)))],
  ['坐标不全要问', '来209', '', (r) => !r.actions.length && /[?？]|哪|坐标/.test(r.reply)],
  ['一个数飞行要问', '飞到3019', '', (r) => !r.actions.length],
  ['生物掉落', '帮我收集一些粘液球', '', (r) => cmds(r).some((c) => ['explore', 'hunt'].includes(c)) && !cmds(r).includes('digdown')],
  ['挂机', '别跟着我了在这挂机', '', (r) => cmds(r).includes('stay')],
  ['回来', '回来', '', (r) => cmds(r).includes('come')],
  ['闲聊不动手', '你今天心情怎么样', '', (r) => !r.actions.length],
  ['这个=看着的方块', '把这棵树砍了', '', (r) => cmds(r).some((c) => ['chop', 'mine', 'excavate'].includes(c))],
  ['长指令拆清单', '砍20个木头，做个箱子，放到我这里，然后回家', '', (r) => (r.tasks?.length || 0) >= 4 && r.done === false],
  ['复杂规划', '帮我准备一套铁装备，然后挖一组圆石，晚上记得睡觉', '', (r) => (r.tasks?.length || 0) >= 3 && r.done === false],
  ['拿东西用 get', '我要一把铁镐', '', (r) => cmds(r).includes('get') || /已有|背包/.test(r.reply)],
  ['箱子里有就去拿', '给我拿10个铁锭', '', (r) => cmds(r).includes('fetch'), '箱子记忆: iron_ingotx30(最近 120,70,205)'],
  ['照经验避坑', '帮我挖钻石', '', (r) => !cmds(r).includes('digdown'), '过往经验: 「帮我挖钻石」没做成，卡在 digdown（失败）：get iron_pickaxe → digdown'],
  ['不盖房子', '给我盖个房子', '', (r) => !cmds(r).some((c) => ['build', 'fill', 'paste'].includes(c))],
  ['不用稀有材料', '用钻石块给我砌堵墙', '', (r) => !r.actions.some((a) => a.args.some((x) => /diamond/.test(x)))],
  ['找不等于做', '看看附近有没有铁矿', '', (r) => cmds(r).some((c) => ['find', 'explore'].includes(c))],
  ['步行要求', '走路去家，别飞', '', (r) => cmds(r).includes('walk') || cmds(r).includes('go')],
  ['清单带验收', '砍8个橡木', '', (r) => cmds(r).some((c) => ['chop', 'get', 'mine'].includes(c))],
]
async function main() {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) { console.log('没有 DEEPSEEK_API_KEY，跳过'); return }
  const model = process.argv.find((a) => a.startsWith('--model='))?.slice(8)
  let pass = 0
  for (const [name, text, prior, ok, extra] of CASES) {
    const ai = createAI({ apiKey: key, model, thinking: !process.argv.includes('--off'), getName: () => 'Claude_Bot', now: (() => { let t = 0; return () => (t += 61_000) })() })
    const start = Date.now()
    try {
      if (prior) await ai.ask('luomo', prior, STATE)
      const r = await ai.ask('luomo', text, extra ? `${STATE}；${extra}` : STATE)
      const good = ok(r)
      pass += good ? 1 : 0
      console.log(`${good ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - start) / 1000).toFixed(0)}s): ${JSON.stringify({ u: r.understanding, reply: r.reply, a: r.actions, tasks: r.tasks?.map((t) => t.text), done: r.done })}`)
    } catch (err) { console.log(`FAIL ${name}: ${err.code} ${err.detail || err.message}`) }
  }
  console.log(`== intent: ${pass}/${CASES.length} ==`)
}
main()
