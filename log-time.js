// 由 start.sh 用 node --require 预加载：给常驻日志每行加本地时间。
// 以前 logs/bot.log 没有时间，断线、卡住发生在哪次部署之后只能靠 [startup] 版本号猜。
const pad = (n) => String(n).padStart(2, '0')
function stamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
for (const method of ['log', 'info', 'warn', 'error']) {
  const original = console[method].bind(console)
  console[method] = (...args) => original(stamp(), ...args)
}
module.exports = { stamp }
