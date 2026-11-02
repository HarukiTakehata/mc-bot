// AI 链路实机：模型输出用回放（不评价模型本身），验证长指令续跑、格式修复重试、excavate 和坑底起飞
const { createLab, rcon, assert, sleep, NAME, TESTER } = require('./harness')
const scenarios = {
  async '清单_谎报完成要被逼着做完'(lab) {
    await lab.arena(30600, 0); lab.give('minecraft:oak_log', 4); await sleep(61_000)
    lab.say('bot 谎报完成')
    const text = await lab.waitChat(/完成了|停下|坚持结束/, 120_000)
    assert(text && /完成了/.test(text), `结果: ${text}; ${lab.chatSince().join(' | ')}`)
    assert(lab.count('minecraft:oak_planks') >= 2, '第二项被跳过了')
    return { said: lab.chatSince().slice(-4) }
  },
  async '验收_没挖就说挖完要被退回'(lab) {
    const a = await lab.arena(30700, 0); await sleep(61_000)
    rcon(`fill ${a.cx + 2} 100 ${a.cz - 1} ${a.cx + 3} 102 ${a.cz + 1} minecraft:dirt`); await sleep(800)
    lab.say(`bot 假装挖完 100 ${a.cx}`)
    const text = await lab.waitChat(/完成了|停下|坚持结束/, 180_000)
    assert(text && /完成了/.test(text), `结果: ${text}; ${lab.chatSince().join(' | ')}`)
    assert(lab.block(a.cx + 2, 101, a.cz, 'minecraft:air'), '没真的挖')
    return { said: lab.chatSince().slice(-4) }
  },
  async '中途改要求_进度和取消当场响应'(lab) {
    await lab.arena(30800, 0); lab.give('minecraft:oak_log', 4); await sleep(61_000)
    lab.say('bot 做两件事')
    assert(await lab.waitChat(/开始/, 30_000), '没开始')
    await sleep(800)
    const s1 = Date.now(); lab.say('bot 你在干嘛')
    assert(await lab.waitChat(/在做「做两件事」|手上有事/, 8000, s1), `没答进度: ${lab.chatSince().join(' | ')}`)
    lab.say('bot 再拿木板')
    const text = await lab.waitChat(/完成了|停下/, 120_000, s1)
    assert(text && /完成了/.test(text), `结果: ${text}; ${lab.chatSince(s1).join(' | ')}`)
    assert(lab.count('minecraft:oak_planks') >= 2, '新要求没做')
    return { said: lab.chatSince(s1).slice(-4) }
  },
  async '容错_一轮请求失败长任务继续'(lab) {
    await lab.arena(30900, 0); lab.give('minecraft:oak_log', 4); await sleep(61_000)
    lab.say('bot 坏一轮')
    const text = await lab.waitChat(/完成了|停下/, 120_000)
    assert(text && /完成了/.test(text), `结果: ${text}; ${lab.chatSince().join(' | ')}`)
    assert(lab.count('minecraft:oak_planks') >= 2, '第二项没做')
    return {}
  },
  async '空转_同样动作没变化要自己停'(lab) {
    const a = await lab.arena(31000, 0); await sleep(61_000)
    lab.say('bot 一直找')
    const text = await lab.waitChat(/都没变化/, 240_000)
    assert(text, `没停: ${lab.chatSince().join(' | ')}`)
    return { said: text, at: a.cx }
  },
  async '记忆_做过的事和箱子下一轮能看到'(lab) {
    const a = await lab.arena(31100, 0); lab.give('minecraft:oak_log', 4)
    lab.setblock(a.cx + 2, 100, a.cz, 'minecraft:chest')
    rcon(`item replace block ${a.cx + 2} 100 ${a.cz} container.0 with minecraft:iron_ingot 7`); await sleep(61_000)
    assert((await lab.cmd('bot chestscan', /看了 1 个箱子/, /没有|没打开/, 20_000)).ok, '没扫到箱子')
    lab.say('bot 探针任务')
    assert(await lab.waitChat(/完成了/, 60_000), `目标没完成: ${lab.chatSince().join(' | ')}`)
    await lab.idle(10_000)
    const s = Date.now(); lab.say('bot 记忆探针 探针任务')
    const text = await lab.waitChat(/经验(有|无) 箱子(有|无)/, 30_000, s)
    assert(text === '经验有 箱子有' || /经验有 箱子有/.test(text || ''), `state 里没带上: ${text}`)
    return { said: text }
  },
  async '长指令_第一步做完自动接着做'(lab) {
    await lab.arena(30000, 0); lab.give('minecraft:oak_log', 4); await sleep(800)
    lab.say('bot 先拿木棍再拿木板')
    const text = await lab.waitChat(/完成了|停下|没能完成/, 120_000)
    assert(text && /完成了/.test(text), `结果: ${text}; ${lab.chatSince().join(' | ')}`)
    assert(lab.count('minecraft:stick') >= 2, '没有木棍')
    assert(lab.count('minecraft:oak_planks') >= 2, '第二步没做')
    return { said: lab.chatSince().slice(-5) }
  },
  async '格式错_带原因重试一次后照常执行'(lab) {
    await sleep(60_000) // 前面的场景会用掉每分钟 6 次的 AI 额度，等窗口过去
    const a = await lab.arena(30100, 0)
    lab.setblock(a.cx + 2, 100, a.cz, 'minecraft:oak_log'); await sleep(800)
    const mark = lab.log.length
    lab.say('bot 第一次写坏')
    assert(await lab.waitChat(/改短了/, 30_000), `没重试: ${lab.chatSince().join(' | ')}`)
    assert(/没通过校验，重试: reply 超过/.test(lab.log.slice(mark)), '日志没记原因')
    return {}
  },
  async 'excavate_只挖高于条件的土_其他不动'(lab) {
    const a = await lab.arena(30200, 0)
    rcon(`fill ${a.cx + 2} 100 ${a.cz - 2} ${a.cx + 4} 102 ${a.cz + 2} minecraft:dirt`)
    lab.setblock(a.cx + 5, 101, a.cz, 'minecraft:oak_planks'); await sleep(800)
    lab.say('bot 挖掉高处 100')
    const text = await lab.waitChat(/挖了 \d+ 格/, 120_000)
    assert(text, `没结果: ${lab.chatSince().join(' | ')}`)
    for (let x = 2; x <= 4; x++) for (let z = -2; z <= 2; z++) {
      assert(lab.block(a.cx + x, 100, a.cz + z, 'minecraft:dirt'), `y=100 不该挖 ${x},${z}`)
      if (Math.hypot(x, z) <= 3.9) assert(lab.block(a.cx + x, 101, a.cz + z, 'minecraft:air'), `y=101 没挖 ${x},${z}`)
    }
    assert(lab.block(a.cx + 5, 101, a.cz, 'minecraft:oak_planks'), '木板被挖了')
    return { said: text }
  },
  async 'excavate_不接受箱子和门'(lab) {
    await lab.arena(30300, 0)
    const r = await lab.cmd('bot excavate chest', /不行/, /$^/, 8000)
    assert(r.ok, r.text)
    return {}
  },
  async '打史莱姆_拿到粘液球'(lab) {
    const a = await lab.arena(30400, 0)
    lab.give('minecraft:iron_sword', 1); await sleep(600)
    // 放远一点：贴脸的小史莱姆会被自卫逻辑先打死，轮不到 hunt
    rcon(`summon minecraft:slime ${a.cx + 14} 100 ${a.cz} {Size:0,PersistenceRequired:1b}`)
    const r = await lab.cmd('bot hunt slime', /打了 \d+ 只/, /没有/, 60_000)
    assert(r.ok, r.text)
    return { said: r.text }
  },
  async '坑底下令飞_先出坑再起飞'(lab) {
    await lab.arena(30500, 0, 30)
    rcon(`gamemode creative ${TESTER}`)
    rcon(`item replace entity ${NAME} armor.chest with minecraft:elytra`); lab.give('minecraft:firework_rocket', 64); lab.give('minecraft:iron_pickaxe', 1); await sleep(800)
    const d = await lab.cmd('bot digdown 6', /往下挖了/, /$^/, 60_000); assert(d.ok, d.text)
    await lab.idle(20_000)
    const s = Date.now()
    lab.say('bot fly 31100 0')
    const text = await lab.waitChat(/对接到|已飞抵|失败/, 240_000, s)
    assert(text && /对接到|已飞抵/.test(text), `结果: ${text}; ${lab.chatSince(s).join(' | ')}`)
    return { said: text, hp: lab.health() }
  },
}
async function main() {
  const lab = createLab({ fakeAI: true })
  rcon('gamerule spawn_mobs false')
  await lab.startBot(); await lab.startTester()
  await lab.run('aiflow', scenarios, process.argv.slice(2))
  await lab.stop(); process.exit(0)
}
main().catch((err) => { console.error(err); process.exit(1) })
