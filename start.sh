#!/bin/sh
# 类 Unix 系统的启动入口。服务器和 AI 后端设置见 .env.example。
set -eu
umask 077
cd "$(dirname "$0")"
mkdir -p logs
# 日志超过 5MB 就轮转一份（常驻时每次重启都会经过这里）
if [ -f logs/bot.log ] && [ "$(wc -c < logs/bot.log)" -gt 5000000 ]; then
  # 保留原 inode，兼容由外部进程管理器打开的日志输出。
  cp -p logs/bot.log logs/bot.log.1
  : > logs/bot.log
fi
# 使用 Node 的 dotenv 解析，不把配置内容作为 shell 代码执行。
# MC_VERSION 不填就自动检测服务器版本
exec node --env-file-if-exists=.env --max-old-space-size=256 --require ./log-time.js bot.js
