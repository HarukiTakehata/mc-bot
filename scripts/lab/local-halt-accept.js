// 实机验收 3：清背包 → 自主砍树中 → 玩家 come 抢占 → halt 不应取消玩家的 come
const mineflayer = require('mineflayer')
const t0 = Date.now()
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a)
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'Tester', version: '26.1.2', auth: 'offline' })
bot.on('messagestr', (m) => log('[chat]', m))
bot.on('error', (e) => log('[error]', e.message))
bot.once('spawn', async () => {
  const say = async (ms, msg) => { await new Promise((r) => setTimeout(r, ms)); if (msg) { log('>> ' + msg); bot.chat(msg) } }
  await say(2500, '/clear LabBot')
  await say(12000, 'bot status')
  await say(1500, 'bot come')
  await say(6000, 'bot status')
  await say(2000, 'bot halt')
  await say(3000, 'bot status')
  await say(2000, null)
  bot.quit()
})
setTimeout(() => { log('hard timeout'); process.exit(0) }, 70_000)
