#!/bin/bash
# CoEditor 一键启动：./start.sh [要打开的本地文件夹]
# 不传目录时打开仓库自带的示例目录 ./sample
set -e
cd "$(dirname "$0")"
VAULT="${1:-./sample}"
echo "CoEditor 启动中 → vault: $VAULT"
echo "（打开终端里打印的 127.0.0.1 地址即可；Ctrl+C 退出）"
exec node server.mjs "$VAULT"
