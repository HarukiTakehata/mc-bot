// 实机驱动：以玩家身份进服，向 LabBot 发聊天指令并收集它的回复
const mineflayer = require('mineflayer')
const t0 = Date.now()
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a)

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: 'Tester',
  version: process.env.MC_VERSION || '26.1.2',
  auth: 'offline',
})

bot.on('messagestr', (m) => log('[chat]', m))
bot.on('error', (e) => log('[error]', e.message))
bot.on('kicked', (r) => log('[kicked]', JSON.stringify(r)))

bot.once('spawn', async () => {
  log('tester spawned at', bot.entity.position.toString())
  const say = async (ms, msg) => {
    await new Promise((r) => setTimeout(r, ms))
    if (msg) { log('>> ' + msg); bot.chat(msg) }
  }
  await say(3000, 'bot pos')
  await say(7000, 'bot status')
  await say(7000, 'bot scan')
  await say(9000, 'bot come')
  await say(20000, null)
  log('done')
  bot.quit()
})

setTimeout(() => { log('hard timeout'); process.exit(0) }, 90_000)
