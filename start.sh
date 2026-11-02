#!/bin/zsh
# 启动机器人。默认连本机 test 服；连其他服务器用 MC_HOST=<服务器地址> ./start.sh
# DeepSeek 密钥放在同目录 .env（DEEPSEEK_API_KEY=...），没有就只认固定指令
set -e
umask 077
cd "$(dirname "$0")"
mkdir -p logs
# 日志超过 5MB 就轮转一份（常驻时每次重启都会经过这里）
if [[ -f logs/bot.log && $(stat -f%z logs/bot.log) -gt 5000000 ]]; then
  # launchd 已打开 stdout，保留原 inode，避免后续输出继续落进旧文件。
  cp -p logs/bot.log logs/bot.log.1
  : > logs/bot.log
fi
# 使用 Node 的 dotenv 解析，不把配置内容作为 shell 代码执行。
export MC_VERSION=${MC_VERSION:-26.1}
exec node --env-file-if-exists=.env --max-old-space-size=256 --require ./log-time.js bot.js
