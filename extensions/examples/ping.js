// 示例 .js 扩展：注册一个只读指令 bot ping，并在机器人死亡时记一行日志。
// 复制到 extensions/ 目录（和本文件夹同级）再重启机器人才会加载。
module.exports = {
  id: 'ping',
  name: '示例：延迟查询',
  activate: 'always', // 不依赖任何模组，哪种服务器都启用
  setup(api) {
    api.command('ping', {
      help: '看机器人到服务器的延迟',
      read: true, // 只读：忙的时候也能用，私聊来的私聊回
      run: () => api.say(`延迟 ${api.bot.player?.ping ?? '?'} ms`),
    })
    api.on('death', () => api.log('机器人死了一次'))
  },
}
