// 实机驱动 2：验证寻路与挖掘
const mineflayer = require('mineflayer')
const t0 = Date.now()
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a)
const bot = mineflayer.createBot({
  host: '127.0.0.1', port: 25565, username: 'Tester2', version: '26.1.2', auth: 'offline',
})
bot.on('messagestr', (m) => log('[chat]', m))
bot.on('error', (e) => log('[error]', e.message))
bot.once('spawn', async () => {
  log('tester2 spawned')
  const say = async (ms, msg) => { await new Promise((r) => setTimeout(r, ms)); if (msg) { log('>> ' + msg); bot.chat(msg) } }
  await say(3000, 'bot mine dirt 3')
  await say(25000, 'bot inv')
  await say(8000, 'bot status')
  await say(4000, null)
  bot.quit()
})
setTimeout(() => { log('hard timeout'); process.exit(0) }, 100_000)
